import * as React from 'react'
import * as CodeMirror from 'codemirror'
import * as URL from 'url'
import { UserAutocompletionProvider, IUserHit } from '../autocompletion'
import { Editor, Doc, Position } from 'codemirror'
import { isDotComApiEndpoint } from '../../lib/api'
import { compare } from '../../lib/compare'
import { arrayEquals } from '../../lib/equality'
import { OcticonSymbol } from '../octicons'

/**
 * A representation of an 'author'. In reality we're
 * talking about co-authors here but the representation
 * is general purpose.
 *
 * For visualization purposes this object represents a
 * string such as
 *
 *  Foo Bar <foo@bar.com>
 *
 * Additionally it includes an optional username which is
 * solely for presentation purposes inside AuthorInput
 */
export interface IAuthor {
  /** The author real name */
  readonly name: string

  /** The author email address */
  readonly email: string

  /**
   * The GitHub.com or GitHub Enterprise login for
   * this author or null if that information is not
   * available.
   */
  readonly username: string | null
}

/**
 * Convert a IUserHit object which is returned from
 * user-autocomplete-provider into an IAuthor object.
 *
 * If the IUserHit object lacks an email address we'll
 * attempt to create a stealth email address.
 */
function authorFromUserHit(user: IUserHit): IAuthor {
  return {
    name: user.name || user.username,
    email: getEmailAddressForUser(user),
    username: user.username,
  }
}

interface IAuthorInputProps {
  /**
   * An optional class name for the wrapper element around the
   * author input component
   */
  readonly className?: string
  readonly autoCompleteProvider: UserAutocompletionProvider

  readonly authors: ReadonlyArray<IAuthor>
  readonly onAuthorsUpdated: (authors: ReadonlyArray<IAuthor>) => void
}

function prevPosition(doc: Doc, pos: Position) {
  return doc.posFromIndex(doc.indexFromPos(pos) - 1)
}

function nextPosition(doc: Doc, pos: Position) {
  return doc.posFromIndex(doc.indexFromPos(pos) + 1)
}

// mark ranges are inclusive, this checks exclusive
function posIsInsideMarkedText(doc: Doc, pos: Position) {
  const marks = (doc.findMarksAt(pos) as any) as ActualTextMarker[]
  const ix = doc.indexFromPos(pos)

  return marks.some(mark => {
    const markPos = mark.find()
    const from = doc.indexFromPos(markPos.from)
    const to = doc.indexFromPos(markPos.to)

    return ix > from && ix < to
  })
}

function isMarkOrWhitespace(doc: Doc, pos: Position) {
  const line = doc.getLine(pos.line)
  if (/\s/.test(line.charAt(pos.ch))) {
    return true
  }

  return posIsInsideMarkedText(doc, pos)
}

function posEquals(x: Position, y: Position) {
  return x.line === y.line && x.ch === y.ch
}

function scanWhile(
  doc: Doc,
  start: Position,
  predicate: (doc: Doc, pos: Position) => boolean,
  iter: (doc: Doc, pos: Position) => Position
) {
  let pos = start

  for (
    let next = iter(doc, start);
    predicate(doc, next) && !posEquals(pos, next);
    next = iter(doc, next)
  ) {
    pos = next
  }

  return pos
}

function scanUntil(
  doc: Doc,
  start: Position,
  predicate: (doc: Doc, pos: Position) => boolean,
  iter: (doc: Doc, pos: Position) => Position
): Position {
  return scanWhile(doc, start, (doc, pos) => !predicate(doc, pos), iter)
}

function getHintRangeFromCursor(doc: Doc, cursor: Position) {
  return {
    from: scanUntil(doc, cursor, isMarkOrWhitespace, prevPosition),
    to: scanUntil(doc, cursor, isMarkOrWhitespace, nextPosition),
  }
}

function appendTextMarker(
  cm: Editor,
  text: string,
  options: CodeMirror.TextMarkerOptions
): ActualTextMarker {
  const doc = cm.getDoc()
  const from = doc.posFromIndex(Infinity)

  doc.replaceRange(text, from)
  const to = doc.posFromIndex(Infinity)

  return (doc.markText(from, to, options) as any) as ActualTextMarker
}

function orderByPosition(x: ActualTextMarker, y: ActualTextMarker) {
  const xPos = x.find()
  const yPos = y.find()

  if (xPos === undefined || yPos === undefined) {
    return compare(xPos, yPos)
  }

  return compare(xPos.from, yPos.from)
}

// The types for CodeMirror.TextMarker is all wrong, this is what it
// actually looks like
interface ActualTextMarker extends CodeMirror.TextMarkerOptions {
  /** Remove the mark. */
  clear(): void

  /**
   * Returns a {from, to} object (both holding document positions), indicating
   * the current position of the marked range, or undefined if the marker is
   * no longer in the document.
   */
  find(): {
    from: Position
    to: Position
  }

  changed(): void
}

function renderUnknownUserAutocompleteItem(
  elem: HTMLElement,
  self: any,
  data: any
) {
  const text = data.username as string
  const user = document.createElement('div')
  user.classList.add('user', 'unknown')

  const username = document.createElement('span')
  username.className = 'username'
  username.innerText = text
  user.appendChild(username)

  const description = document.createElement('span')
  description.className = 'description'
  description.innerText = `Search for user`
  user.appendChild(description)

  elem.appendChild(user)
}

function renderUserAutocompleteItem(elem: HTMLElement, self: any, data: any) {
  const author = data.author as IAuthor
  const user = document.createElement('div')
  user.className = 'user'

  // This will always be non-null when we get it from the
  // autocompletion provider but let's be extra cautious
  if (author.username) {
    const username = document.createElement('span')
    username.className = 'username'
    username.innerText = author.username
    user.appendChild(username)
  }

  const name = document.createElement('span')
  name.className = 'name'
  name.innerText = author.name

  user.appendChild(name)
  elem.appendChild(user)
}

function getEmailAddressForUser(user: IUserHit) {
  if (user.email && user.email.length > 0) {
    return user.email
  }

  const url = URL.parse(user.endpoint)
  const host =
    url.hostname && !isDotComApiEndpoint(user.endpoint)
      ? url.hostname
      : 'github.com'

  return `${user.username}@users.noreply.${host}`
}

function getDisplayTextForAuthor(author: IAuthor) {
  return author.username === null ? author.name : `@${author.username}`
}

function renderHandleMarkReplacementElement(author: IAuthor) {
  const elem = document.createElement('span')
  elem.classList.add('handle')
  elem.title = `${author.name} <${author.email}>`
  elem.innerText = getDisplayTextForAuthor(author)

  return elem
}

function renderUnknownHandleMarkReplacementElement(
  username: string,
  isError: boolean
) {
  const elem = document.createElement('span')

  elem.classList.add('handle', isError ? 'error' : 'progress')
  elem.title = isError
    ? `Could not find user with username ${username}`
    : `Searching for @${username}`

  const symbol = isError ? OcticonSymbol.stop : OcticonSymbol.sync

  const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  spinner.classList.add('icon')

  if (!isError) {
    spinner.classList.add('spin')
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')

  spinner.viewBox.baseVal.width = symbol.w
  spinner.viewBox.baseVal.height = symbol.h

  path.setAttribute('d', symbol.d)
  spinner.appendChild(path)

  elem.appendChild(document.createTextNode(`@${username}`))
  elem.appendChild(spinner)

  return elem
}

function markRangeAsHandle(
  doc: Doc,
  from: Position,
  to: Position,
  author: IAuthor
): ActualTextMarker {
  const elem = renderHandleMarkReplacementElement(author)

  return (doc.markText(from, to, {
    atomic: true,
    className: 'handle',
    readOnly: false,
    replacedWith: elem,
    handleMouseEvents: true,
  }) as any) as ActualTextMarker
}

function triggerAutoCompleteBasedOnCursorPosition(cm: Editor) {
  const doc = cm.getDoc()

  if (doc.somethingSelected()) {
    return
  }

  const cursor = doc.getCursor()
  const p = scanUntil(doc, cursor, isMarkOrWhitespace, prevPosition)

  if (posEquals(cursor, p)) {
    return
  }

  ;(cm as any).showHint()
}

export class AuthorInput extends React.Component<IAuthorInputProps, {}> {
  /**
   * The codemirror instance if mounted, otherwise null
   */
  private editor: Editor | null = null

  /**
   * Resize observer used for tracking width changes and
   * refreshing the internal codemirror instance when
   * they occur
   */
  private readonly resizeObserver: ResizeObserver
  private resizeDebounceId: number | null = null
  private lastKnownWidth: number | null = null

  /**
   * Whether or not the hint (i.e. autocompleter)
   * is currently active.
   */
  private hintActive: boolean = false

  /**
   * A reference to the label mark (the persistent
   * part of the placeholder text)
   */
  private label: ActualTextMarker | null = null

  /**
   * A reference to the placeholder mark (the second
   * part of the placeholder text which is collapsed
   * when there's user input)
   */
  private placeholder: ActualTextMarker | null = null

  /**
   * The internal list of authors. Note that codemirror
   * ultimately is the source of truth for what authors
   * are in here but we synchronize that into this field
   * whenever codemirror reports a change. We also use
   * this array to detect whether the author props have
   * change, in which case we blow away everything and
   * start from scratch.
   */
  private authors: ReadonlyArray<IAuthor> = []

  // For undo association
  private readonly markAuthorMap = new Map<ActualTextMarker, IAuthor>()
  private readonly authorMarkMap = new Map<IAuthor, ActualTextMarker>()

  public constructor(props: IAuthorInputProps) {
    super(props)

    // Observe size changes and let codemirror know
    // when it needs to refresh.
    this.resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 1 && this.editor) {
        const newWidth = entries[0].contentRect.width

        // We don't care about the first resize, let's just
        // store what we've got
        if (!this.lastKnownWidth) {
          this.lastKnownWidth = newWidth
          return
        }

        // Codemirror already does a good job of height changes,
        // we just need to care about when the width changes and
        // do a relayout
        if (this.lastKnownWidth !== newWidth) {
          this.lastKnownWidth = newWidth

          if (this.resizeDebounceId !== null) {
            cancelAnimationFrame(this.resizeDebounceId)
            this.resizeDebounceId = null
          }
          requestAnimationFrame(this.onResized)
        }
      }
    })

    this.state = {}
  }

  public componentWillReceiveProps(nextProps: IAuthorInputProps) {
    if (
      nextProps.authors !== this.props.authors &&
      !arrayEquals(this.authors, nextProps.authors)
    ) {
      const cm = this.editor
      if (cm) {
        cm.operation(() => {
          this.reset(cm, nextProps.authors)
        })
      }
    }
  }

  private onResized = () => {
    this.resizeDebounceId = null
    if (this.editor) {
      this.editor.refresh()
    }
  }

  private onContainerRef = (elem: HTMLDivElement) => {
    if (elem) {
      const cm = this.initializeCodeMirror(elem)
      this.editor = cm
      this.resizeObserver.observe(elem)
    } else {
      this.editor = null
      this.resizeObserver.disconnect()
    }
  }

  private applyCompletion = (cm: Editor, data: any, completion: any) => {
    const from: Position = completion.from || data.from
    const to: Position = completion.to || data.to
    const author: IAuthor = completion.author

    this.insertAuthor(cm, author, from, to)
  }

  private applyUnknownUserCompletion = (
    cm: Editor,
    data: any,
    completion: any
  ) => {
    const from: Position = completion.from || data.from
    const to: Position = completion.to || data.to
    const username: string = completion.username
    const text = `@${username}`
    const doc = cm.getDoc()

    doc.replaceRange(text, from, to, 'complete')
    const end = doc.posFromIndex(doc.indexFromPos(from) + text.length)

    const tmpMark = (doc.markText(from, end, {
      atomic: true,
      className: 'handle progress',
      readOnly: false,
      replacedWith: renderUnknownHandleMarkReplacementElement(username, false),
      handleMouseEvents: true,
    }) as any) as ActualTextMarker

    // Note that it's important that this method isn't async up until
    // this point since show-hint expects a synchronous method
    return this.props.autoCompleteProvider.exactMatch(username).then(hit => {
      cm.operation(() => {
        const tmpPos = tmpMark.find()

        if (!tmpPos) {
          return
        }

        tmpMark.clear()

        if (!hit) {
          doc.markText(tmpPos.from, tmpPos.to, {
            atomic: true,
            className: 'handle error',
            readOnly: false,
            replacedWith: renderUnknownHandleMarkReplacementElement(
              username,
              true
            ),
            handleMouseEvents: true,
          })

          return
        }

        this.insertAuthor(cm, authorFromUserHit(hit), tmpPos.from, tmpPos.to)
      })
    })
  }

  private insertAuthor(
    cm: Editor,
    author: IAuthor,
    from: Position,
    to?: Position
  ) {
    const text = getDisplayTextForAuthor(author)
    const doc = cm.getDoc()

    doc.replaceRange(text, from, to, 'complete')

    const end = doc.posFromIndex(doc.indexFromPos(from) + text.length)
    const marker = markRangeAsHandle(doc, from, end, author)

    this.markAuthorMap.set(marker, author)
    this.authorMarkMap.set(author, marker)

    return marker
  }

  private appendAuthor(cm: Editor, author: IAuthor) {
    const doc = cm.getDoc()
    return this.insertAuthor(cm, author, doc.posFromIndex(Infinity))
  }

  private onAutocompleteUser = async (cm: Editor, x?: any, y?: any) => {
    const doc = cm.getDoc()
    const cursor = doc.getCursor() as Readonly<Position>

    const { from, to } = getHintRangeFromCursor(doc, cursor)

    var word = doc.getRange(from, to)

    const needle = word.replace(/^@/, '')
    const hits = await this.props.autoCompleteProvider.getAutocompletionItems(
      needle
    )

    const existingUsernames = new Set(this.authors.map(x => x.username))

    const list: any[] = hits
      .map(authorFromUserHit)
      .filter(x => x.username === null || !existingUsernames.has(x.username))
      .map(author => ({
        author,
        text: getDisplayTextForAuthor(author),
        render: renderUserAutocompleteItem,
        className: 'autocompletion-item',
        hint: this.applyCompletion,
      }))

    if (needle.length > 0) {
      list.push({
        text: `@${needle}`,
        username: needle,
        render: renderUnknownUserAutocompleteItem,
        className: 'autocompletion-item',
        hint: this.applyUnknownUserCompletion,
      })
    }

    return { list, from, to }
  }

  private updatePlaceholderVisibility(cm: Editor) {
    if (this.label && this.placeholder) {
      const labelRange = this.label.find()
      const placeholderRange = this.placeholder.find()

      const doc = cm.getDoc()

      const collapse =
        doc.indexFromPos(labelRange.to) !==
        doc.indexFromPos(placeholderRange.from)

      if (this.placeholder.collapsed !== collapse) {
        this.placeholder.collapsed = collapse
        this.placeholder.changed()
      }
    }
  }

  private getAllHandleMarks(cm: Editor): Array<ActualTextMarker> {
    // todo: yuck!
    return (cm.getDoc().getAllMarks() as any) as ActualTextMarker[]
  }

  private initializeCodeMirror(host: HTMLDivElement) {
    const CodeMirrorOptions: CodeMirror.EditorConfiguration & {
      hintOptions: any
    } = {
      mode: null,
      lineWrapping: true,
      extraKeys: {
        Tab: false,
        Enter: false,
        'Shift-Tab': false,
        'Ctrl-Space': 'autocomplete',
        'Ctrl-Enter': false,
        'Cmd-Enter': false,
      },
      hintOptions: {
        completeOnSingleClick: true,
        completeSingle: false,
        closeOnUnfocus: true,
        closeCharacters: /\s/,
        hint: this.onAutocompleteUser,
      },
    }

    const cm = CodeMirror(host, CodeMirrorOptions)

    cm.operation(() => {
      this.reset(cm, this.props.authors)
    })

    cm.on('startCompletion', () => {
      this.hintActive = true
      console.log('startCompletion')
    })

    cm.on('endCompletion', () => {
      this.hintActive = false
      console.log('endCompletion')
    })

    cm.on('change', () => {
      console.log('change')

      this.updatePlaceholderVisibility(cm)

      if (!this.hintActive) {
        triggerAutoCompleteBasedOnCursorPosition(cm)
      }
    })

    cm.on('focus', () => {
      if (!this.hintActive) {
        triggerAutoCompleteBasedOnCursorPosition(cm)
      }
    })

    cm.on('changes', () => {
      this.updateAuthors(cm)
    })

    // Do the very least we can do to pretend that we're a
    // single line textbox. Users can still paste newlines
    // though and if the do we don't care.
    cm.getWrapperElement().addEventListener('keypress', (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Enter') {
        e.preventDefault()
      }
    })

    return cm
  }

  private updateAuthors(cm: Editor) {
    const markers = this.getAllHandleMarks(cm).sort(orderByPosition)
    const authors = new Array<IAuthor>()

    for (const marker of markers) {
      const author = this.markAuthorMap.get(marker)

      // undefined authors shouldn't happen lol
      if (author) {
        authors.push(author)
      }
    }

    console.log('authors', authors)

    if (!arrayEquals(this.authors, authors)) {
      this.authors = authors
      this.props.onAuthorsUpdated(authors)
    }
  }

  private reset(cm: Editor, authors: ReadonlyArray<IAuthor>) {
    const doc = cm.getDoc()

    cm.setValue('')
    doc.clearHistory()

    this.authors = []
    this.authorMarkMap.clear()
    this.markAuthorMap.clear()

    this.label = appendTextMarker(cm, 'Co-Authors ', {
      atomic: true,
      inclusiveLeft: true,
      className: 'label',
      readOnly: true,
    })

    for (const author of authors) {
      this.appendAuthor(cm, author)
    }

    this.authors = this.props.authors

    this.placeholder = appendTextMarker(cm, '@username', {
      atomic: true,
      inclusiveRight: true,
      className: 'placeholder',
      readOnly: true,
      collapsed: authors.length > 0,
    })

    doc.setCursor(this.placeholder.find().from)
  }

  public render() {
    return <div className={this.props.className} ref={this.onContainerRef} />
  }
}

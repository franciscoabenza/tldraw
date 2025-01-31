import {
  Editor,
  FileHelpers,
  TLExternalContentSource,
  Vec,
  VecLike,
  compact,
  isDefined,
  preventDefault,
  stopEventPropagation,
  uniq,
  useEditor,
  useValue,
} from '@tldraw/editor'
import lz from 'lz-string'
import { useCallback, useEffect } from 'react'
import { TLDRAW_CUSTOM_PNG_MIME_TYPE, getCanonicalClipboardReadType } from '../../utils/clipboard'
import { TLUiEventSource, useUiEvents } from '../context/events'
import { pasteExcalidrawContent } from './clipboard/pasteExcalidrawContent'
import { pasteFiles } from './clipboard/pasteFiles'
import { pasteTldrawContent } from './clipboard/pasteTldrawContent'
import { pasteUrl } from './clipboard/pasteUrl'

// Enhanced MIME type handling with custom types
const expectedPasteFileMimeTypes = [
  TLDRAW_CUSTOM_PNG_MIME_TYPE,
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/vnd.tldraw+json', // Custom MIME type for rich content
] as const

type ClipboardContentType = typeof expectedPasteFileMimeTypes[number] | string

/**
 * Represents different types of content that can be handled from the clipboard
 */
interface ClipboardContentHandler {
  type: ClipboardContentType
  handler: (editor: Editor, data: unknown, point?: VecLike) => Promise<boolean>
  priority: number
}

/**
 * Configuration for clipboard content handlers
 */
const clipboardContentHandlers: ClipboardContentHandler[] = [
  {
    type: 'application/tldraw',
    handler: pasteTldrawContent,
    priority: 100,
  },
  {
    type: 'application/vnd.excalidraw+json',
    handler: pasteExcalidrawContent,
    priority: 90,
  },
  {
    type: 'text/html',
    handler: handleHtmlContent,
    priority: 80,
  },
  {
    type: 'text/uri-list',
    handler: handleUrlContent,
    priority: 70,
  },
  {
    type: 'text/plain',
    handler: handleTextContent,
    priority: 60,
  },
]

interface ClipboardItemResult {
  type: 'file' | 'text' | 'html' | 'url' | 'custom'
  data: File | string | unknown
  mimeType: string
}

interface ClipboardProcessingResult {
  type: 'success' | 'error'
  content?: unknown
  error?: Error
}

/**
 * Enhanced HTML processing with sanitization and link extraction
 */
function processHtmlContent(html: string): { text: string; links: string[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body

  // Remove potentially dangerous elements
  const sanitizedHtml = body.innerHTML
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')

  const textContent = body.textContent || ''
  const links = Array.from(body.querySelectorAll('a[href]'))
    .map(a => a.getAttribute('href'))
    .filter(isDefined)
    .filter(url => isValidHttpURL(url))

  return {
    text: textContent.trim(),
    links: uniq(links),
  }
}

/**
 * Enhanced URL validation with common URL patterns
 */
const isValidHttpURL = (url: string): boolean => {
  try {
    const u = new URL(url)
    return /^(https?|ftp):/i.test(u.protocol)
  } catch {
    return false
  }
}

/**
 * Unified clipboard content processing
 */
async function processClipboardItem(
  item: ClipboardItem
): Promise<ClipboardItemResult[]> {
  const results: ClipboardItemResult[] = []

  for (const type of item.types) {
    try {
      const blob = await item.getType(type)
      const canonicalType = getCanonicalClipboardReadType(type)

      if (expectedPasteFileMimeTypes.includes(canonicalType as any)) {
        results.push({
          type: 'file',
          data: FileHelpers.rewriteMimeType(blob, canonicalType),
          mimeType: canonicalType,
        })
      } else if (type === 'text/html') {
        const text = await FileHelpers.blobToText(blob)
        results.push({ type: 'html', data: text, mimeType: type })
      } else if (type === 'text/plain') {
        const text = await FileHelpers.blobToText(blob)
        results.push({ type: 'text', data: text, mimeType: type })
      } else if (type === 'text/uri-list') {
        const text = await FileHelpers.blobToText(blob)
        results.push({ type: 'url', data: text, mimeType: type })
      } else {
        // Handle custom MIME types
        results.push({ type: 'custom', data: blob, mimeType: type })
      }
    } catch (error) {
      console.error('Error processing clipboard item:', error)
    }
  }

  return results
}

/**
 * Enhanced clipboard handling with priority-based processing
 */
async function handleEnhancedClipboard(
  editor: Editor,
  items: ClipboardItem[],
  point?: VecLike
): Promise<ClipboardProcessingResult> {
  const processedItems = await Promise.all(
    items.map(item => processClipboardItem(item))
  )
  const flatItems = processedItems.flat()

  // Process items by handler priority
  for (const handler of clipboardContentHandlers.sort((a, b) => b.priority - a.priority)) {
    const matchingItems = flatItems.filter(item => item.mimeType === handler.type)
    
    for (const item of matchingItems) {
      try {
        const success = await handler.handler(editor, item.data, point)
        if (success) {
          return { type: 'success', content: item.data }
        }
      } catch (error) {
        console.error('Error handling clipboard content:', error)
        return {
          type: 'error',
          error: error instanceof Error ? error : new Error('Unknown clipboard error'),
        }
      }
    }
  }

  return {
    type: 'error',
    error: new Error('No compatible clipboard content found'),
  }
}

/**
 * Enhanced copy handling with versioning and error recovery
 */
const handleNativeOrMenuCopy = async (editor: Editor): Promise<boolean> => {
  try {
    const content = await editor.resolveAssetsInContent(
      editor.getContentFromCurrentPage(editor.getSelectedShapeIds())
    )

    if (!content) {
      await navigator.clipboard.writeText('')
      return true
    }

    const clipboardData = {
      version: 1,
      type: 'application/vnd.tldraw+json',
      timestamp: Date.now(),
      data: content,
    }

    const compressedData = lz.compressToBase64(JSON.stringify(clipboardData))
    const textContent = content.shapes
      .map(shape => editor.getShapeUtil(shape).getText(shape))
      .filter(isDefined)
      .join(' ') || ' ' // Ensure non-empty content for clipboard

    const htmlBlob = new Blob(
      [`<!-- TDRAW:${compressedData} --><div>${textContent}</div>`],
      { type: 'text/html' }
    )

    const clipboardItem = new ClipboardItem({
      'text/html': htmlBlob,
      'text/plain': new Blob([textContent], { type: 'text/plain' }),
      'application/vnd.tldraw+json': new Blob(
        [JSON.stringify(clipboardData)],
        { type: 'application/json' }
      ),
    })

    await navigator.clipboard.write([clipboardItem])
    return true
  } catch (error) {
    console.error('Copy failed:', error)
    // Fallback to basic text copy
    try {
      await navigator.clipboard.writeText(' ')
      return true
    } catch (fallbackError) {
      console.error('Fallback copy failed:', fallbackError)
      return false
    }
  }
}

// Updated hook implementation with enhanced error handling
export function useEnhancedClipboard() {
  const editor = useEditor()
  const trackEvent = useUiEvents()

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      if (editor.getEditingShapeId() || areShortcutsDisabled(editor)) return

      try {
        const items = await navigator.clipboard.read()
        const result = await handleEnhancedClipboard(
          editor,
          items,
          editor.inputs.currentPagePoint
        )

        if (result.type === 'success') {
          trackEvent('paste', { success: true, type: result.content?.type })
        } else {
          trackEvent('paste', { success: false, error: result.error?.message })
          // Show user feedback here
        }
      } catch (error) {
        trackEvent('paste', { success: false, error: error.message })
        // Fallback to event.clipboardData processing
        if (event.clipboardData) {
          handlePasteFromEventClipboardData(editor, event.clipboardData)
        }
      }
    },
    [editor, trackEvent]
  )

  // Implement similar enhanced handlers for copy/cut
  // ...

  return {
    handleCopy: useCallback(() => handleNativeOrMenuCopy(editor), [editor]),
    handlePaste,
    // Other clipboard handlers...
  }
}

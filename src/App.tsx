import { useEffect, useMemo, useState, useRef } from 'react'
import './App.css'

type ApiResponse = {
  videoId: string
  summary: string
  transcript: string
  truncated?: boolean
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api'

function isSupportedVideoUrl(input: string): boolean {
  try {
    const u = new URL(input)
    const host = u.hostname.toLowerCase()
    if (host.includes('youtube.com') || host === 'youtu.be') return true
    if (host.includes('tiktok.com')) return true
    if (host.includes('instagram.com')) return true
    return false
  } catch {
    // allow bare YouTube IDs
    return /^[a-zA-Z0-9_-]{11}$/.test(input)
  }
}

function App() {
  const [url, setUrl] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [canShare, setCanShare] = useState(false)
  const [loadingStepIndex, setLoadingStepIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const LOADING_STEPS = useMemo(
    () => [
      'Fetching transcript…',
      'Transcribing video…',
      'Summarizing with AI…',
      'Preparing results…',
    ],
    []
  )

  function resetAll() {
    setUrl('')
    setData(null)
    setError(null)
    setIsSubmitting(false)
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch {}
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  useEffect(() => {
    setCanShare(Boolean((navigator as any)?.share))
  }, [])

  useEffect(() => {
    if (!isSubmitting) return
    setLoadingStepIndex(0)
    const interval = setInterval(() => {
      setLoadingStepIndex((i) => (i + 1) % LOADING_STEPS.length)
    }, 1400)
    return () => clearInterval(interval)
  }, [isSubmitting, LOADING_STEPS.length])

  const isValid = useMemo(() => !!isSupportedVideoUrl(url), [url])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setData(null)
    if (!isValid) {
      setError('Please enter a supported video URL (YouTube, TikTok, Instagram)')
      return
    }
    setIsSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}))
        throw new Error(msg.error || `Request failed (${res.status})`)
      }
      const json: ApiResponse = await res.json()
      setData(json)
    } catch (err: any) {
      setError(err?.message || 'Failed to summarize video')
    } finally {
      setIsSubmitting(false)
    }
  }

  const canSubmit = isValid && !isSubmitting

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {}
  }

  async function shareWithAI() {
    try {
      if (!canShare) return
      const shareData: any = {
        title: 'Video summary',
        text: data?.summary ? stripHtml(renderRichSummary(data.summary)) : 'Check out this video summary',
      }
      if (url) (shareData as any).url = url
      await (navigator as any).share(shareData)
    } catch {}
  }

  return (
    <div className="container">
      <header>
        <h1 className="brand as-link" onClick={resetAll} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') resetAll() }}><span className="yt-accent">▶</span> YouTube Summarizer</h1>
        <p className="subtitle">Paste a YouTube, TikTok, or Instagram link to get a concise summary.</p>
      </header>

      <form onSubmit={handleSubmit} className="form">
        <input
          ref={inputRef}
          type="url"
          placeholder="Paste a video URL (YouTube, TikTok, Instagram)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={`input ${url && !isValid ? 'input-error' : ''}`}
          aria-invalid={!!(url && !isValid)}
        />
        <button className="primary" type="submit" disabled={!canSubmit}>
          {isSubmitting ? 'Summarizing…' : 'Summarize it'}
        </button>
      </form>
      {url && !isValid && <p className="helper error">Enter a supported video link (YouTube, TikTok, Instagram)</p>}
      {error && <div className="alert error">{error}</div>}
      {isSubmitting && (
        <section className="loading">
          <div className="loader">
            <div className="spinner" aria-hidden="true" />
            <div>
              <p className="loading-title">Please wait…</p>
              <ul className="steps" aria-live="polite">
                {LOADING_STEPS.map((s, i) => (
                  <li key={s} className={`step ${i === loadingStepIndex ? 'active' : i < loadingStepIndex ? 'done' : ''}`}>
                    <span className="bullet" /> {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {data && (
        <section className="results">
          {data.truncated && (
            <div className="alert warn">Transcript was long; summary is based on a truncated portion.</div>
          )}
          <div className="panel panel-light">
            <div className="panel-header">
              <h2>Summary</h2>
              <div className="actions">
                <button className="ghost" onClick={() => copy(data.summary)}>📋 Copy Summary</button>
                <button className="ghost" onClick={() => copy(data.transcript)}>🧾 Copy Transcript</button>
                {canShare && (
                  <button className="ghost" onClick={shareWithAI}>🤖 Share with AI</button>
                )}
              </div>
            </div>
            <article className="content" dangerouslySetInnerHTML={{ __html: renderRichSummary(data.summary) }} />
          </div>
        </section>
      )}

      <footer>
      </footer>
    </div>
  )
}

function renderRichSummary(text: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const toInlineHtml = (raw: string) => {
    let s = esc(raw)
    // bold+italic ***text***
    s = s.replace(/\*\*\*\s*([\s\S]*?)\s*\*\*\*/g, '<em><strong>$1</strong></em>')
    // bold **text** or __text__
    s = s.replace(/\*\*\s*([\s\S]*?)\s*\*\*/g, '<strong>$1</strong>')
    s = s.replace(/__\s*([\s\S]*?)\s*__/g, '<strong>$1</strong>')
    // italic *text* (avoid **)
    s = s.replace(/(^|[^*])\*\s*([^*][\s\S]*?)\s*\*(?!\*)/g, (_, pre, inner) => pre + '<em>' + inner + '</em>')
    // italic _text_ (avoid __)
    s = s.replace(/(^|[^_])_(?!_)\s*([\s\S]*?)\s*_(?!_)/g, (_, pre, inner) => pre + '<em>' + inner + '</em>')
    // timestamps [mm:ss] or [h:mm:ss]
    s = s.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="timestamp">[$1]</span>')
    return s
  }
  const lines = text.split(/\r?\n/)
  const html: string[] = []
  for (const original of lines) {
    const line = original.trim()
    if (!line) { html.push(''); continue }
    // Headings starting with #
    if (/^#+\s+/.test(line)) {
      const level = Math.min(6, (line.match(/^#+/)!)[0].length)
      html.push(`<h${level}>${toInlineHtml(line.replace(/^#+\s+/, ''))}</h${level}>`)
      continue
    }
    // Lines like " ** Title ** " or " * ** Subtitle ** * " → treat as h3
    if (/^\*?\s*\*\*[\s\S]+\*\*\s*\*?$/.test(line)) {
      const inner = line.replace(/^\*?\s*/, '').replace(/\s*\*?$/, '')
      html.push(`<h3>${toInlineHtml(inner)}</h3>`)
      continue
    }
    // Bullet items: -, *, •
    if (/^[-*•]\s+/.test(line)) {
      html.push(`<li>${toInlineHtml(line.replace(/^[-*•]\s+/, ''))}</li>`)
      continue
    }
    // Default paragraph
    html.push(`<p>${toInlineHtml(line)}</p>`)
  }
  // Wrap consecutive <li> into <ul>
  const joined = html.join('\n')
  const ulWrapped = joined.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul class=\"list\">\n${m}\n<\/ul>\n`)
  return ulWrapped
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent || tmp.innerText || ''
}

export default App

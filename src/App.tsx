import { useMemo, useState } from 'react'
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

  return (
    <div className="container">
      <header>
        <h1>YouTube Summarizer</h1>
        <p className="subtitle">Paste a YouTube, TikTok, or Instagram link, get a concise summary with timestamps.</p>
      </header>

      <form onSubmit={handleSubmit} className="form">
        <input
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

      {data && (
        <section className="results">
          {data.truncated && (
            <div className="alert warn">Transcript was long; summary is based on a truncated portion.</div>
          )}
          <div className="panel">
            <div className="panel-header">
              <h2>Summary</h2>
              <button className="ghost" onClick={() => copy(data.summary)}>Copy</button>
            </div>
            <article className="content" dangerouslySetInnerHTML={{ __html: renderMarkdownLike(data.summary) }} />
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>Transcript</h2>
              <button className="ghost" onClick={() => copy(data.transcript)}>Copy</button>
            </div>
            <pre className="transcript" aria-label="Transcript"><code>{data.transcript}</code></pre>
          </div>
        </section>
      )}

      <footer>
        <a href="https://netlify.com" target="_blank" rel="noreferrer">Deployed on Netlify</a>
      </footer>
    </div>
  )
}

function renderMarkdownLike(text: string): string {
  // Minimal markdown-like rendering for headings and bullets
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const lines = text.split(/\r?\n/)
  const html: string[] = []
  for (const line of lines) {
    if (/^\s*[-•]\s+/.test(line)) {
      html.push(`<li>${esc(line.replace(/^\s*[-•]\s+/, ''))}</li>`) 
    } else if (/^#+\s+/.test(line)) {
      const level = Math.min(6, line.match(/^#+/)![0].length)
      html.push(`<h${level}>${esc(line.replace(/^#+\s+/, ''))}</h${level}>`)
    } else if (/^\s*$/.test(line)) {
      html.push('')
    } else {
      html.push(`<p>${esc(line)}</p>`)
    }
  }
  // Wrap consecutive <li> into <ul>
  const joined = html.join('\n')
  const ulWrapped = joined.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>\n${m}\n</ul>\n`)
  return ulWrapped
}

export default App

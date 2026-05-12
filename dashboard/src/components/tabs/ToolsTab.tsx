/**
 * GitHub Issue #147: Tools tab with live deep links
 * Feature: Smart launcher for Red Hat business value tools + artifact upload
 * Status: Phase 2 — active links with customer context
 */

import { Wrench, ExternalLink, Upload, Copy, Check, FileText, FileSpreadsheet, Loader2 } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'

interface ToolsTabProps {
  customerName: string
}

interface Customer {
  name: string
  accountNumbers?: string[]
}

interface Artifact {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  webViewLink: string
}

export function ToolsTab({ customerName }: ToolsTabProps) {
  const [accountNumbers, setAccountNumbers] = useState<string[]>([])
  const [copiedAccount, setCopiedAccount] = useState<string | null>(null)

  // Upload state
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ fileName: string; webViewLink: string } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch customer account numbers
  useEffect(() => {
    fetch('/api/accounts')
      .then((r) => r.json())
      .then((json) => {
        const customer = (json.customers ?? []).find(
          (c: Customer) => c.name.toLowerCase() === customerName.toLowerCase()
        )
        if (customer?.accountNumbers) {
          setAccountNumbers(customer.accountNumbers)
        }
      })
      .catch(() => {})
  }, [customerName])

  // Fetch artifacts on mount
  const fetchArtifacts = async () => {
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/tools/artifacts`)
      if (res.ok) {
        const data = await res.json()
        setArtifacts(data.artifacts || [])
      }
    } catch {}
  }

  useEffect(() => {
    fetchArtifacts()
  }, [customerName])

  // Upload handler
  const handleUpload = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    setUploadResult(null)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/tools/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        setUploadError(err.error || 'Upload failed')
        return
      }
      const data = await res.json()
      setUploadResult({ fileName: data.fileName, webViewLink: data.webViewLink })
      fetchArtifacts() // refresh list
    } catch (e: any) {
      setUploadError(e.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      handleUpload(files[0])
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleUpload(files[0])
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedAccount(text)
    setTimeout(() => setCopiedAccount(null), 2000)
  }

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) return <FileText className="w-4 h-4 text-red-400" />
    if (mimeType.includes('presentation')) return <FileSpreadsheet className="w-4 h-4 text-orange-400" />
    return <FileText className="w-4 h-4 text-text-secondary" />
  }

  const formatDate = (isoDate: string) => {
    try {
      const date = new Date(isoDate)
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }).format(date)
    } catch {
      return isoDate
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Wrench className="w-5 h-5 text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Business Value Tools</h1>
        </div>
        <p className="text-sm text-text-secondary">
          Launch Red Hat business value tools with {customerName} pre-filled. Upload outputs to sync with Google Drive and NotebookLM.
        </p>
      </div>

      {/* Tool cards grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* PitchBuilder+ */}
        <a
          href="https://pitchbuilderplus.redhat.com/export"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-accent/50 transition-colors group"
        >
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">PitchBuilder+</h3>
            <p className="text-xs text-text-secondary leading-relaxed mb-2">
              Export sales-ready reports showcasing Red Hat's delivered value for <span className="font-medium text-text-primary">{customerName}</span>
            </p>
            {accountNumbers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {accountNumbers.map((acct) => (
                  <div key={acct} className="flex items-center gap-1 bg-bg-primary/50 rounded px-2 py-1">
                    <span className="text-xs font-mono text-text-secondary">{acct}</span>
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        copyToClipboard(acct)
                      }}
                      className="hover:text-accent transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedAccount === acct ? (
                        <Check className="w-3 h-3 text-green-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="w-full px-3 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium text-center group-hover:bg-accent/20 transition-colors">
            Launch Tool
          </div>
        </a>

        {/* FinListics CBV */}
        <a
          href="https://v2.finlistics-vm.com/start-page"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-accent/50 transition-colors group"
        >
          <div className="flex items-start justify-between">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <Wrench className="w-5 h-5 text-accent" />
            </div>
            <ExternalLink className="w-4 h-4 text-text-secondary group-hover:text-accent transition-colors" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">FinListics CBV</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              Account planning, benchmarking, and prospect analysis for <span className="font-medium text-text-primary">{customerName}</span>
            </p>
          </div>
          <div className="w-full px-3 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium text-center group-hover:bg-accent/20 transition-colors">
            Launch Tool
          </div>
        </a>

      </div>

      {/* Upload area */}
      <div
        className={`bg-surface border-2 ${
          dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-border border-dashed'
        } rounded-xl p-8 text-center space-y-3 transition-colors cursor-pointer`}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          accept=".pdf,.ppt,.pptx"
        />

        {uploading ? (
          <>
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm font-medium text-text-primary">Uploading...</p>
          </>
        ) : uploadResult ? (
          <>
            <Check className="w-8 h-8 text-green-500 mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-green-500">Upload successful</p>
              <p className="text-xs text-text-secondary">{uploadResult.fileName}</p>
            </div>
            <a
              href={uploadResult.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-accent/10 text-xs text-accent font-medium hover:bg-accent/20 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              Open in Drive
              <ExternalLink className="w-3 h-3" />
            </a>
          </>
        ) : uploadError ? (
          <>
            <Upload className="w-8 h-8 text-red-400 mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-red-400">Upload failed</p>
              <p className="text-xs text-text-secondary">{uploadError}</p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setUploadError(null)
              }}
              className="px-4 py-2 rounded-lg border border-border text-xs text-text-secondary hover:border-accent/50 transition-colors"
            >
              Try Again
            </button>
          </>
        ) : (
          <>
            <Upload className="w-8 h-8 text-text-secondary mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-text-primary">Upload tool outputs</p>
              <p className="text-xs text-text-secondary max-w-sm mx-auto">
                Drag and drop reports from PitchBuilder+, FinListics, or CBVS here to sync them with {customerName}'s Drive folder and NotebookLM sources.
              </p>
            </div>
            <div className="px-4 py-2 rounded-lg border border-border text-xs text-accent font-medium hover:border-accent/50 transition-colors inline-block">
              Select Files
            </div>
          </>
        )}
      </div>

      {/* Artifacts list */}
      {artifacts.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-text-primary">Uploaded Artifacts</h2>
            <span className="text-xs text-text-secondary bg-surface border border-border rounded-full px-2 py-0.5">
              {artifacts.length}
            </span>
          </div>
          <div className="space-y-2">
            {artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="bg-surface border border-border rounded-lg p-4 flex items-center justify-between hover:border-accent/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {getFileIcon(artifact.mimeType)}
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-text-primary">{artifact.name}</p>
                    <p className="text-xs text-text-secondary">{formatDate(artifact.modifiedTime)}</p>
                  </div>
                </div>
                <a
                  href={artifact.webViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent/10 text-xs text-accent font-medium hover:bg-accent/20 transition-colors"
                >
                  Open in Drive
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

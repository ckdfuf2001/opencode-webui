import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { applyRepoTrackingAll } from '@/api/repos'
import { showToast } from '@/lib/toast'
import { Loader2, RefreshCw } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { TTSSettings } from './TTSSettings'

export function GeneralSettings() {
  const { preferences, isLoading, updateSettings, isUpdating } = useSettings()
  
  const [gitToken, setGitToken] = useState('')
  const [repoTrackPathsInput, setRepoTrackPathsInput] = useState('')
  const [isApplyingTracking, setIsApplyingTracking] = useState(false)

  useEffect(() => {
    if (preferences) {
      setGitToken(preferences.gitToken || '')
      setRepoTrackPathsInput((preferences.repoTrackPaths ?? []).join(', '))
    }
  }, [preferences])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-6">General Preferences</h2>
      
      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="theme">Theme</Label>
          <Select 
            value={preferences?.theme || 'dark'} 
            onValueChange={(value) => updateSettings({ theme: value as 'dark' | 'light' | 'system' })}
          >
            <SelectTrigger id="theme">
              <SelectValue placeholder="Select a theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            Choose your preferred color scheme
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mode">Mode</Label>
          <Select 
            value={preferences?.mode || 'build'} 
            onValueChange={(value) => updateSettings({ mode: value as 'plan' | 'build' })}
          >
            <SelectTrigger id="mode">
              <SelectValue placeholder="Select a mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="plan">Plan</SelectItem>
              <SelectItem value="build">Build</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            Plan mode: Read-only. Build mode: File changes enabled
          </p>
        </div>

        <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="autoScroll" className="text-base">Auto-scroll</Label>
            <p className="text-sm text-muted-foreground">
              Automatically scroll to bottom when new messages arrive
            </p>
          </div>
          <Switch
            id="autoScroll"
            checked={preferences?.autoScroll ?? true}
            onCheckedChange={(checked) => updateSettings({ autoScroll: checked })}
          />
        </div>

        <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="showReasoning" className="text-base">Show reasoning</Label>
            <p className="text-sm text-muted-foreground">
              Display model reasoning and thought process
            </p>
          </div>
          <Switch
            id="showReasoning"
            checked={preferences?.showReasoning ?? false}
            onCheckedChange={(checked) => updateSettings({ showReasoning: checked })}
          />
        </div>

        <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="expandToolCalls" className="text-base">Expand tool calls</Label>
            <p className="text-sm text-muted-foreground">
              Automatically expand tool call details by default
            </p>
          </div>
          <Switch
            id="expandToolCalls"
            checked={preferences?.expandToolCalls ?? false}
            onCheckedChange={(checked) => updateSettings({ expandToolCalls: checked })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="gitToken">GitHub Personal Access Token</Label>
          <Input
            id="gitToken"
            type="password"
            placeholder="ghp_..."
            value={gitToken}
            onChange={(e) => setGitToken(e.target.value)}
            onBlur={() => updateSettings({ gitToken })}
            className="bg-background border-border text-foreground placeholder:text-muted-foreground"
          />
          <p className="text-sm text-muted-foreground">
            Required for cloning private repos. Get one at github.com/settings/tokens
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="repoTrackPaths">Registry git tracking paths</Label>
          <div className="flex gap-2">
            <Input
              id="repoTrackPaths"
              placeholder=".opencode, scripts"
              value={repoTrackPathsInput}
              onChange={(e) => setRepoTrackPathsInput(e.target.value)}
              onBlur={() => {
                const paths = repoTrackPathsInput
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter(Boolean)
                const current = (preferences?.repoTrackPaths ?? []).join(', ')
                if (paths.join(', ') !== current) {
                  updateSettings({ repoTrackPaths: paths })
                }
              }}
              className="bg-background border-border text-foreground placeholder:text-muted-foreground"
            />
            <Button
              type="button"
              variant="outline"
              disabled={isApplyingTracking}
              onClick={async () => {
                setIsApplyingTracking(true)
                try {
                  const result = await applyRepoTrackingAll()
                  showToast.success(`Applied tracking to ${result.applied} repo${result.applied === 1 ? '' : 's'}`)
                } catch (error) {
                  showToast.error(error instanceof Error ? error.message : 'Failed to apply repo tracking')
                } finally {
                  setIsApplyingTracking(false)
                }
              }}
            >
              {isApplyingTracking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Apply to existing repos
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Repo-relative paths tracked for version history (comma-separated). All other files are
            excluded from change detection via .git/info/exclude. Saved paths apply to newly created
            repos; use "Apply to existing repos" to update all current ones. Empty = track everything.
          </p>
        </div>

        {isUpdating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Saving...</span>
          </div>
        )}
      </div>

      <div className="mt-6">
        <TTSSettings />
      </div>
    </div>
  )
}

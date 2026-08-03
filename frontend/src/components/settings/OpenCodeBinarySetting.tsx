import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { settingsApi } from '@/api/settings'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Save, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function OpenCodeBinarySetting() {
  const { preferences, isLoading, updateSettingsAsync } = useSettings()
  const [path, setPath] = useState('')

  useEffect(() => {
    if (preferences) {
      setPath(preferences.opencodeBin || '')
    }
  }, [preferences])

  const restartMutation = useMutation({
    mutationFn: () => settingsApi.restartOpenCodeServer(),
  })

  const handleSave = async () => {
    await updateSettingsAsync({ opencodeBin: path.trim() || undefined })
    restartMutation.mutate()
  }

  const busy = isLoading || restartMutation.isPending

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">OpenCode Binary</CardTitle>
        <CardDescription>
          Path to the opencode executable used to run the server. Leave empty to auto-detect, or to run
          the web UI without an OpenCode connection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="opencodeBin">Executable path</Label>
            <div className="flex gap-2">
              <Input
                id="opencodeBin"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="C:\Users\you\.bun\bin\opencode.exe or opencode"
                className="bg-background border-border text-foreground placeholder:text-muted-foreground font-mono"
              />
              <Button onClick={handleSave} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save & Restart
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {preferences?.opencodeBin ? (
              <>
                Using <span className="font-mono">{preferences.opencodeBin}</span>. Saving updates the path
                and restarts the server.
              </>
            ) : (
              <>
                No path set - the server starts without an OpenCode connection until a binary is configured.
                Saving starts the server with the path above.
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Already running with the current path? Use Restart Server to relaunch it.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
            <p className="text-sm font-medium text-foreground">Not installed?</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-background border border-border px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap overflow-x-auto">
                bun install -g opencode-ai
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText('bun install -g opencode-ai')}
              >
                Copy
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Or download the latest release from{' '}
              <a
                href="https://github.com/sst/opencode/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:text-blue-400 underline underline-offset-2"
              >
                github.com/sst/opencode/releases
              </a>
              . After installing, paste the binary path above and hit Save &amp; Restart.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

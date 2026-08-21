import { useState, useMemo } from 'react'
import { Terminal, Globe } from 'lucide-react'
import { ResourceEditor } from '@/components/ui/resource-editor'
import { AddMcpServerDialog } from './AddMcpServerDialog'
import { useMutation, useQueryClient } from '@tanstack/react-query'

function getServerDisplayName(serverId: string): string {
  const name = serverId.replace(/[-_]/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function getServerDescription(serverConfig: any): string {
  if (serverConfig.type === 'local' && serverConfig.command) {
    const command = serverConfig.command.join(' ')
    if (command.includes('filesystem')) return 'File system access'
    if (command.includes('git')) return 'Git repository operations'
    if (command.includes('sqlite')) return 'SQLite database access'
    if (command.includes('postgres')) return 'PostgreSQL database access'
    if (command.includes('brave-search')) return 'Web search via Brave'
    if (command.includes('github')) return 'GitHub repository access'
    if (command.includes('slack')) return 'Slack integration'
    if (command.includes('puppeteer')) return 'Web automation'
    if (command.includes('fetch')) return 'HTTP requests'
    if (command.includes('memory')) return 'Persistent memory'
    return `Local command: ${command}`
  } else if (serverConfig.type === 'remote' && serverConfig.url) {
    return `Remote server: ${serverConfig.url}`
  }
  return 'MCP server'
}

function mcpToItem(serverId: string, serverConfig: any): any {
  const badges: { label: string; className: string }[] = [
    { label: serverConfig.enabled ? 'Enabled' : 'Disabled', className: serverConfig.enabled ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
    { label: serverConfig.type, className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  ]

  return {
    id: serverId,
    name: getServerDisplayName(serverId),
    description: getServerDescription(serverConfig),
    icon: serverConfig.type === 'local' ? Terminal : Globe,
    badges,
    metadata: {
      type: serverConfig.type,
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout ? `${serverConfig.timeout}ms` : undefined,
      envCount: serverConfig.environment ? Object.keys(serverConfig.environment).length : 0,
    },
    data: serverConfig,
  }
}

interface McpManagerProps {
  config: {
    name: string
    content: Record<string, unknown>
  } | null
  onUpdate: (content: Record<string, unknown>) => Promise<void>
  onConfigUpdate?: (configName: string, content: Record<string, unknown>) => Promise<void>
}

export function McpManager({ config, onUpdate, onConfigUpdate }: McpManagerProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [deleteConfirmServer, setDeleteConfirmServer] = useState<{ id: string; name: string } | null>(null)
  const [togglingServerId, setTogglingServerId] = useState<string | null>(null)

  const queryClient = useQueryClient()

  const toggleServerMutation = useMutation({
    mutationFn: async ({ serverId, enabled }: { serverId: string; enabled: boolean }) => {
      if (!config) return

      setTogglingServerId(serverId)

      const currentMcp = (config.content?.mcp as Record<string, any>) || {}
      const serverConfig = currentMcp[serverId]

      if (!serverConfig) return

      const updatedConfig = {
        ...config.content,
        mcp: {
          ...currentMcp,
          [serverId]: {
            ...serverConfig,
            enabled,
          },
        },
      }

      await onUpdate(updatedConfig)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['opencode-config'] })
    },
    onSettled: () => {
      setTogglingServerId(null)
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: async (serverId: string) => {
      if (!config) return

      const currentMcp = (config.content?.mcp as Record<string, any>) || {}
      const { [serverId]: deleted, ...rest } = currentMcp

      const updatedConfig = {
        ...config.content,
        mcp: rest,
      }

      await onUpdate(updatedConfig)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['opencode-config'] })
    },
  })

  const mcpServers = config?.content?.mcp as Record<string, any> || {}

  const isAnyOperationPending = toggleServerMutation.isPending || deleteServerMutation.isPending || togglingServerId !== null

  const handleToggleServer = (serverId: string, enabled: boolean) => {
    toggleServerMutation.mutate({ serverId, enabled })
  }

  const mcpGroups = useMemo((): any[] => {
    const items = Object.entries(mcpServers).map(([serverId, serverConfig]) => mcpToItem(serverId, serverConfig))
    return [
      {
        id: 'mcp',
        label: 'MCP Servers',
        icon: Globe,
        items,
      },
    ]
  }, [mcpServers])

  const handleToggleServerWrapper = (item: any) => {
    handleToggleServer(item.id, !item.data.enabled)
  }

  const handleDelete = (item: any) => {
    setDeleteConfirmServer({ id: item.id, name: item.name })
  }

  if (!config) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Select a configuration to manage MCP servers.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 relative min-h-[200px]">
      {isAnyOperationPending && (
        <div className="absolute inset-0 -m-4 bg-background/90 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3 bg-card border border-border rounded-lg p-6 shadow-lg">
            <span className="h-8 w-8 animate-spin text-primary border-4 border-primary/30 rounded-full border-t-transparent" />
            <span className="text-sm font-medium text-foreground">
              {togglingServerId ? 'Updating MCP server...' : 'Processing...'}
            </span>
            <span className="text-xs text-muted-foreground">
              Please wait while we update your configuration
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">MCP Servers</h3>
          <p className="text-sm text-muted-foreground">
            Manage Model Context Protocol servers for {config.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="h-6 gap-1"
            onClick={() => setIsAddDialogOpen(true)}
            disabled={isAnyOperationPending}
          >
            <span className="text-xs">Add Server</span>
          </button>
        </div>
      </div>

      <ResourceEditor
        groups={mcpGroups}
        onItemEdit={handleToggleServerWrapper}
        editLabel={(item) => ((item.data as { enabled?: boolean } | undefined)?.enabled ? 'Disable' : 'Enable')}
        onItemDelete={handleDelete}
        emptyMessage="No MCP servers configured. Add your first server to get started."
        emptyIcon={Globe}
        searchPlaceholder="Search MCP servers..."
        isLoading={isAnyOperationPending}
      />

      <AddMcpServerDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onUpdate={onConfigUpdate}
      />

      {deleteConfirmServer && (
        <div className="absolute inset-0 -m-4 bg-background/90 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="flex flex-col gap-3 bg-card border border-border rounded-lg p-6 shadow-lg w-80">
            <span className="text-sm font-medium text-foreground">Delete {deleteConfirmServer.name}?</span>
            <span className="text-xs text-muted-foreground">This will remove the server from your configuration.</span>
            <div className="flex justify-end gap-2">
              <button
                className="h-6 gap-1"
                onClick={() => setDeleteConfirmServer(null)}
                disabled={deleteServerMutation.isPending}
              >
                <span className="text-xs">Cancel</span>
              </button>
              <button
                className="h-6 gap-1"
                onClick={() => {
                  deleteServerMutation.mutate(deleteConfirmServer.id)
                  setDeleteConfirmServer(null)
                }}
                disabled={deleteServerMutation.isPending}
              >
                <span className="text-xs">Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
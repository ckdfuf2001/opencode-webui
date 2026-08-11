import { useState } from 'react'
import { FileText as FileTextIcon } from 'lucide-react'
import { ResourceEditor } from '@/components/ui/resource-editor'
import { AgentDialog } from './AgentDialog'
import { APPROVAL_TYPE_LABELS, inferApprovalType } from './agentTypes'

export function AgentsEditor({ agents, onChange }: { agents: Record<string, any>; onChange: (agents: Record<string, any>) => void }) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<{ name: string; agent: any } | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">Agents</h3>
          <p className="text-sm text-muted-foreground">{Object.keys(agents).length} configured</p>
        </div>
        <button className="h-6 gap-1" onClick={() => setIsCreateDialogOpen(true)}>
          <span className="h-4 w-4">+</span>
          <span className="text-xs">New</span>
        </button>
      </div>

      <ResourceEditor
        groups={[
          {
            id: 'agents',
            label: 'Agents',
            icon: FileTextIcon,
            items: Object.entries(agents).map(([name, agent]) => ({
              id: name,
              name,
              description: agent.description ?? '',
              icon: FileTextIcon,
              badges: [
                { label: APPROVAL_TYPE_LABELS[inferApprovalType(agent)], className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
                { label: agent.mode, className: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
                ...(agent.disable ? [{ label: 'disabled', className: 'bg-red-500/15 text-red-400 border-red-500/30' }] : []),
                ...(agent.model?.providerID ? [{ label: `${agent.model.providerID}/${agent.model.modelID}`, className: 'bg-gray-500/15 text-gray-400 border-gray-500/30' }] : []),
              ],
              metadata: {
                mode: agent.mode,
                approvalType: inferApprovalType(agent),
                temperature: agent.temperature,
                topP: agent.topP,
                model: agent.model?.modelID ? `${agent.model.providerID}/${agent.model.modelID}` : undefined,
                disable: agent.disable,
              },
              data: agent,
            })),
          },
        ]}
        onItemEdit={(item) => setEditingAgent({ name: item.id, agent: item.data! })}
        onItemDelete={(item) => {
          const updatedAgents = { ...agents }
          delete updatedAgents[item.id]
          onChange(updatedAgents)
        }}
        emptyMessage="No agents configured. Add your first agent to get started."
        emptyIcon={FileTextIcon}
        searchPlaceholder="Search agents..."
      />

      <AgentDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onSubmit={(name, agent) => {
          if (editingAgent) {
            const updatedAgents = { ...agents }
            delete updatedAgents[editingAgent.name]
            updatedAgents[name] = agent
            onChange(updatedAgents)
            setEditingAgent(null)
          } else {
            onChange({ ...agents, [name]: agent })
          }
        }}
      />
      <AgentDialog
        open={!!editingAgent}
        onOpenChange={() => setEditingAgent(null)}
        onSubmit={(name, agent) => {
          if (editingAgent) {
            const updatedAgents = { ...agents }
            delete updatedAgents[editingAgent.name]
            updatedAgents[name] = agent
            onChange(updatedAgents)
            setEditingAgent(null)
          } else {
            onChange({ ...agents, [name]: agent })
          }
        }}
        editingAgent={editingAgent}
      />
    </div>
  )
}
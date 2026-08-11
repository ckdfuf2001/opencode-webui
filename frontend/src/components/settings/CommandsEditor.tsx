import { useState, useMemo } from 'react'
import { Terminal as TerminalIcon } from 'lucide-react'
import { ResourceEditor, ResourceEditorHeader, type ResourceItem, type ResourceGroup } from '@/components/ui/resource-editor'
import { CommandDialog } from './CommandDialog'

interface Command {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
  topP?: number
}

interface CommandsEditorProps {
  commands: Record<string, Command>
  onChange: (commands: Record<string, Command>) => void
}

function commandToItem(name: string, command: Command): ResourceItem<Command> {
  const badges: { label: string; className: string }[] = []
  if (command.agent) badges.push({ label: command.agent, className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' })
  if (command.model) badges.push({ label: command.model.split('/').pop() || command.model, className: 'bg-purple-500/15 text-purple-400 border-purple-500/30' })
  if (command.subtask) badges.push({ label: 'subtask', className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' })

  return {
    id: name,
    name: `/${name}`,
    description: command.description,
    icon: TerminalIcon,
    badges,
    metadata: {
      agent: command.agent,
      model: command.model,
      subtask: command.subtask,
      topP: command.topP,
    },
    preview: command.template,
    data: command,
  }
}

export function CommandsEditor({ commands, onChange }: CommandsEditorProps) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [editingCommand, setEditingCommand] = useState<{ name: string; command: Command } | null>(null)

  const commandGroups = useMemo((): ResourceGroup<Command>[] => {
    const items = Object.entries(commands).map(([name, command]) => commandToItem(name, command))
    return [
      {
        id: 'commands',
        label: 'Commands',
        icon: TerminalIcon,
        items,
      },
    ]
  }, [commands])

  const handleCommandSubmit = (name: string, command: Command) => {
    if (editingCommand) {
      const updatedCommands = { ...commands }
      delete updatedCommands[editingCommand.name]
      updatedCommands[name] = command
      onChange(updatedCommands)
      setEditingCommand(null)
    } else {
      onChange({ ...commands, [name]: command })
    }
  }

  const handleDelete = (item: ResourceItem<Command>) => {
    const updatedCommands = { ...commands }
    delete updatedCommands[item.id]
    onChange(updatedCommands)
  }

  const handleEdit = (item: ResourceItem<Command>) => {
    setEditingCommand({ name: item.id, command: item.data! })
  }

  return (
    <div className="space-y-4">
      <ResourceEditorHeader
        title="Commands"
        subtitle={`${Object.keys(commands).length} configured`}
        onCreate={() => setIsCreateDialogOpen(true)}
        createLabel="New"
      />

      <ResourceEditor<Command>
        groups={commandGroups}
        onItemEdit={handleEdit}
        onItemDelete={handleDelete}
        emptyMessage="No commands configured. Add your first command to get started."
        emptyIcon={TerminalIcon}
        searchPlaceholder="Search commands..."
      />

      <CommandDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onSubmit={handleCommandSubmit}
      />
      <CommandDialog
        open={!!editingCommand}
        onOpenChange={() => setEditingCommand(null)}
        onSubmit={handleCommandSubmit}
        editingCommand={editingCommand}
      />
    </div>
  )
}
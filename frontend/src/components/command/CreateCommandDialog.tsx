import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { registryApi, type RegistryType, type RegistryScope, type RegistryAgentMode } from '@/api/registry'
import { settingsApi } from '@/api/settings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { showToast } from '@/lib/toast'

type Mode = 'steps' | 'template'
export type DialogType = RegistryType | 'mcp'

export interface EditingEntry {
  kind: 'registry' | 'config-command' | 'config-agent' | 'mcp'
  type: DialogType
  scope: RegistryScope
  name: string
  description: string
  content?: string
  mode?: RegistryAgentMode
  template?: string
  agent?: string
  model?: string
  topP?: number
  subtask?: boolean
  prompt?: string
  mcpType?: 'local' | 'remote'
  mcpCommand?: string
  mcpUrl?: string
  mcpEnvironment?: { key: string; value: string }[]
  mcpTimeout?: string
  mcpEnabled?: boolean
}

interface EnvironmentVariable {
  key: string
  value: string
}

interface CreateCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  availableSkills?: string[]
  directory?: string
  initialType?: DialogType
  editing?: EditingEntry | null
}

const TYPE_OPTIONS: { value: DialogType; label: string }[] = [
  { value: 'command', label: 'Command' },
  { value: 'skill', label: 'Skill' },
  { value: 'tool', label: 'Plugin' },
  { value: 'agent', label: 'Agent' },
  { value: 'mcp', label: 'MCP' },
]

const SCOPE_OPTIONS: { value: RegistryScope; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' },
]

const TYPE_LABEL: Record<RegistryType, string> = {
  command: 'Command',
  skill: 'Skill',
  tool: 'Plugin',
  agent: 'Agent',
}

const TYPE_LABEL_LOWER: Record<RegistryType, string> = {
  command: 'command',
  skill: 'skill',
  tool: 'plugin',
  agent: 'agent',
}

const GLOBAL_TARGET_DIR = '.config/opencode'

const TOOL_TEMPLATE = (description: string) => `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "${description.replace(/"/g, '\\"')}",
  args: {},
  async execute() {
    return "result"
  },
})`

function buildCommandTemplate(steps: string[], extra: string): string {
  const lines: string[] = []
  if (steps.length > 0) {
    lines.push('Run the following steps strictly in this order. For each step, load the matching skill with the skill tool, then verify the result before moving on.')
    steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`)
    })
    lines.push('')
  }
  if (extra.trim()) lines.push(extra.trim())
  return lines.join('\n')
}

export function CreateCommandDialog({ open, onOpenChange, onCreated, availableSkills = [], directory, initialType = 'command', editing = null }: CreateCommandDialogProps) {
  const [type, setType] = useState<DialogType>(initialType)
  const [scope, setScope] = useState<RegistryScope>(initialType === 'mcp' ? 'global' : 'project')
  const [agent, setAgent] = useState('')
  const [model, setModel] = useState('')
  const [topP, setTopP] = useState('')
  const [subtask, setSubtask] = useState(false)
  const [mode, setMode] = useState<Mode>('template')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const [rawTemplate, setRawTemplate] = useState('')
  const [skillBody, setSkillBody] = useState('')
  const [toolScript, setToolScript] = useState(TOOL_TEMPLATE(''))
  const [agentBody, setAgentBody] = useState('')
  const [agentMode, setAgentMode] = useState<RegistryAgentMode>('all')
  const [saving, setSaving] = useState(false)
  const [mcpType, setMcpType] = useState<'local' | 'remote'>('local')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpEnvironment, setMcpEnvironment] = useState<EnvironmentVariable[]>([])
  const [mcpTimeout, setMcpTimeout] = useState('')
  const [mcpEnabled, setMcpEnabled] = useState(true)

  useEffect(() => {
    if (!open) return
    setType(initialType)
    if (editing) {
      setType(editing.type)
      setName(editing.name)
      setDescription(editing.description ?? '')
      if (editing.kind === 'config-command' || (editing.kind === 'registry' && editing.type === 'command')) {
        setMode('template')
        setRawTemplate(editing.content ?? editing.template ?? '')
        setAgent(editing.agent ?? '')
        setModel(editing.model ?? '')
        setTopP(editing.topP != null ? String(editing.topP) : '')
        setSubtask(editing.subtask ?? false)
        setScope(editing.scope)
      }
      if (editing.kind === 'registry' && editing.type === 'skill') {
        setSkillBody(editing.content ?? '')
        setScope(editing.scope)
      }
      if (editing.kind === 'registry' && editing.type === 'tool') {
        setToolScript(editing.content ?? TOOL_TEMPLATE(''))
        setScope(editing.scope)
      }
      if (editing.kind === 'registry' && editing.type === 'agent') {
        setAgentBody(editing.content ?? '')
        setAgentMode(editing.mode ?? 'all')
        setScope(editing.scope)
      }
      if (editing.kind === 'config-agent') {
        setAgentBody(editing.prompt ?? '')
        setAgentMode(editing.mode ?? 'all')
        setScope('global')
      }
      if (editing.kind === 'config-command') {
        setScope('global')
      }
      if (editing.kind === 'mcp') {
        setMcpType(editing.mcpType ?? 'local')
        setMcpCommand(editing.mcpCommand ?? '')
        setMcpUrl(editing.mcpUrl ?? '')
        setMcpEnvironment(editing.mcpEnvironment ?? [])
        setMcpTimeout(editing.mcpTimeout ?? '')
        setMcpEnabled(editing.mcpEnabled ?? true)
        setScope('global')
      }
    } else {
      setScope(initialType === 'mcp' ? 'global' : 'project')
    }
  }, [open, editing, initialType])

  const reset = () => {
    setName('')
    setDescription('')
    setAgent('')
    setModel('')
    setTopP('')
    setSubtask(false)
    setSteps([])
    setExtra('')
    setRawTemplate('')
    setSkillBody('')
    setToolScript(TOOL_TEMPLATE(''))
    setAgentBody('')
    setAgentMode('all')
    setMcpType('local')
    setMcpCommand('')
    setMcpUrl('')
    setMcpEnvironment([])
    setMcpTimeout('')
    setMcpEnabled(true)
  }

  const handleClose = (next: boolean) => {
    if (!next) {
      reset()
      onOpenChange(false)
    }
  }

  const updateStep = (index: number, value: string) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? value : s)))
  }

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index))
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= steps.length) return
    setSteps((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const addStep = () => {
    setSteps((prev) => [...prev, ''])
  }

  const switchType = (next: DialogType) => {
    setType(next)
    setScope(next === 'mcp' ? 'global' : 'project')
  }

  const resolveContent = (): string => {
    switch (type) {
      case 'command':
        return mode === 'steps' ? buildCommandTemplate(steps, extra) : rawTemplate
      case 'skill':
        return skillBody
      case 'tool':
        return toolScript
      case 'agent':
        return agentBody
      case 'mcp':
        return ''
    }
  }

  const handleSaveMcp = async () => {
    const serverId = name.trim()
    if (!serverId) {
      showToast.error('Server ID is required.')
      return
    }
    setSaving(true)
    try {
      const config = await settingsApi.getDefaultOpenCodeConfig()
      if (!config) {
        showToast.error('No OpenCode configuration to update. Create one first.')
        return
      }
      const currentMcp = (config.content?.mcp as Record<string, unknown> | undefined) ?? {}
      if (editing?.kind === 'mcp' && editing.name !== serverId) {
        delete currentMcp[editing.name]
      }
      const mcpEntry: Record<string, unknown> = { type: mcpType, enabled: mcpEnabled }
      if (mcpType === 'local') {
        const commandArray = mcpCommand.split(' ').filter((arg) => arg.trim())
        if (commandArray.length === 0) {
          showToast.error('Command is required for local MCP servers.')
          return
        }
        mcpEntry.command = commandArray
        const envVars: Record<string, string> = {}
        mcpEnvironment.forEach((env) => {
          if (env.key.trim() && env.value.trim()) envVars[env.key.trim()] = env.value.trim()
        })
        if (Object.keys(envVars).length > 0) mcpEntry.environment = envVars
      } else {
        if (!mcpUrl.trim()) {
          showToast.error('URL is required for remote MCP servers.')
          return
        }
        mcpEntry.url = mcpUrl.trim()
      }
      if (mcpTimeout && parseInt(mcpTimeout)) mcpEntry.timeout = parseInt(mcpTimeout)

      const updatedConfig = {
        ...config.content,
        mcp: { ...currentMcp, [serverId]: mcpEntry },
      }
      await settingsApi.updateOpenCodeConfig(config.name, { content: updatedConfig })
      showToast.success(`MCP server "${serverId}" saved to configuration "${config.name}".`)
      onCreated()
      reset()
      onOpenChange(false)
    } catch (err) {
      console.error('Failed to add MCP server:', err)
      showToast.error('Failed to add MCP server.')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    if (type === 'mcp') {
      await handleSaveMcp()
      return
    }
    const trimmedName = name.trim()
    if (!trimmedName) {
      showToast.error('Name is required.')
      return
    }
    const content = resolveContent()
    if (!content.trim() && !(editing?.kind === 'config-command')) {
      showToast.error('Content is required.')
      return
    }

    setSaving(true)
    try {
      if (type === 'command' && scope === 'global') {
        const { defaultConfig, configs } = await settingsApi.getOpenCodeConfigs()
        const targetName = defaultConfig?.name ?? configs[0]?.name
        if (!targetName) {
          showToast.error('No OpenCode configuration to update. Create one first.')
          return
        }
        const record: Record<string, unknown> = { description: description.trim(), agent, model, subtask }
        if (topP) record.topP = Number(topP)
        if (rawTemplate.trim()) record.template = rawTemplate.trim()
        const current = configs.find((c) => c.name === targetName)?.content ?? defaultConfig?.content ?? {}
        const existingCommands = (current.command as Record<string, unknown> | undefined) ?? {}
        const commands: Record<string, unknown> = { ...existingCommands }
        if (editing?.kind === 'config-command' && editing.name !== trimmedName) {
          delete commands[editing.name]
        }
        commands[trimmedName] = record
        await settingsApi.updateOpenCodeConfig(targetName, { content: { ...current, command: commands } })
        showToast.success(`Command "${trimmedName}" saved to configuration "${targetName}".`)
      } else if (type === 'agent' && editing?.kind === 'config-agent') {
        const config = await settingsApi.getDefaultOpenCodeConfig()
        if (!config) {
          showToast.error('No OpenCode configuration to update. Create one first.')
          return
        }
        const current = { ...config.content }
        const existingAgents = (current.agent as Record<string, unknown> | undefined) ?? {}
        const agents: Record<string, unknown> = { ...existingAgents }
        if (editing.name !== trimmedName) {
          delete agents[editing.name]
        }
        agents[trimmedName] = {
          description: description.trim(),
          mode: agentMode,
          prompt: agentBody.trim(),
        }
        await settingsApi.updateOpenCodeConfig(config.name, { content: { ...current, agent: agents } })
        showToast.success(`Agent "${trimmedName}" saved to configuration "${config.name}".`)
      } else {
        if (scope === 'project' && !directory) {
          showToast.error('No project selected. Use Global scope or open a repo session.')
          return
        }
        if (editing?.kind === 'registry') {
          const changed = editing.type !== type || editing.scope !== scope || editing.name !== trimmedName
          if (changed) {
            await registryApi.unregister(
              editing.type as RegistryType,
              editing.scope,
              editing.name,
              editing.scope === 'project' ? directory : undefined
            )
          }
        }
        await registryApi.register(
          {
            type,
            scope,
            name: trimmedName,
            description: description.trim(),
            content: content.trim(),
            ...(type === 'agent' ? { mode: agentMode } : {}),
          },
          scope === 'project' ? directory : undefined
        )
        showToast.success(`${TYPE_LABEL[type]} "${trimmedName}" registered (${scope}).`)
      }
      onCreated()
      reset()
      onOpenChange(false)
    } catch (err) {
      console.error('Failed to register:', err)
      showToast.error(`Failed to register ${TYPE_LABEL_LOWER[type]}.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-start gap-2 sm:text-left">
          <DialogTitle>{editing ? 'Edit opencode file' : 'Register new opencode file'}</DialogTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-6 h-6 rounded-full border-2 border-foreground text-foreground hover:bg-foreground hover:text-background transition-colors flex items-center justify-center text-sm font-medium flex-shrink-0"
                title="Help"
              >
                ?
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <div className="px-2 py-1.5 space-y-2">
                <div>
                  <a href="https://opencode.ai/docs/commands/" target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:text-primary hover:underline">Command</a>
                  <p className="text-xs text-muted-foreground mt-0.5">A reusable prompt run with /name. Can set agent, model, topP.</p>
                </div>
                <div>
                  <a href="https://opencode.ai/docs/skills/" target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:text-primary hover:underline">Skill</a>
                  <p className="text-xs text-muted-foreground mt-0.5">A markdown skill (SKILL.md) with instructions the agent loads on demand.</p>
                </div>
                <div>
                  <a href="https://opencode.ai/docs/custom-tools/" target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:text-primary hover:underline">Plugin</a>
                  <p className="text-xs text-muted-foreground mt-0.5">A TypeScript tool using @opencode-ai/plugin's tool() helper. Filename becomes the tool name.</p>
                </div>
                <div>
                  <a href="https://opencode.ai/docs/agents/" target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:text-primary hover:underline">Agent</a>
                  <p className="text-xs text-muted-foreground mt-0.5">A markdown agent (mode + system prompt) usable as a primary or subagent.</p>
                </div>
                <div>
                  <a href="https://opencode.ai/docs/mcp-servers/" target="_blank" rel="noreferrer" className="text-sm font-semibold text-foreground hover:text-primary hover:underline">MCP</a>
                  <p className="text-xs text-muted-foreground mt-0.5">A Model Context Protocol server (local command or remote HTTP URL) added to the config.</p>
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {TYPE_OPTIONS.map((opt) => (
              <Button key={opt.value} type="button" size="sm" variant={type === opt.value ? 'secondary' : 'ghost'} onClick={() => switchType(opt.value)} disabled={!!editing} className="text-xs h-7 disabled:opacity-40">
                {opt.label}
              </Button>
            ))}
            <div className="w-px h-5 bg-border mx-1" />
            {SCOPE_OPTIONS.map((opt) => {
              const isMcp = type === 'mcp'
              const lockScope = editing?.kind === 'config-command' || editing?.kind === 'config-agent' || editing?.kind === 'mcp'
              const disabled = (isMcp && opt.value !== 'global') || (!!editing && lockScope && opt.value !== 'global')
              return (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={scope === opt.value ? 'secondary' : 'ghost'}
                  onClick={() => setScope(opt.value)}
                  disabled={disabled}
                  className="text-xs h-7 disabled:opacity-50"
                >
                  {opt.label}
                </Button>
              )
            })}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. ${type === 'mcp' ? 'filesystem' : type}`}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                if (type === 'tool') setToolScript(TOOL_TEMPLATE(e.target.value))
              }}
              placeholder="What this does"
            />
          </div>

          {type === 'command' && (
            <div className="flex items-center gap-1.5">
              {(['steps', 'template'] as Mode[]).map((m) => (
                <Button key={m} type="button" size="sm" variant={mode === m ? 'secondary' : 'ghost'} onClick={() => setMode(m)} className="text-xs h-7">
                  {m === 'steps' ? 'Steps' : 'Full text'}
                </Button>
              ))}
            </div>
          )}

          {type === 'command' && mode === 'steps' && (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Steps (skills to run, in order)</label>
                <div className="space-y-1.5">
                  {steps.map((step, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <span className="w-5 text-right text-xs text-muted-foreground font-mono">{index + 1}.</span>
                      <Input
                        value={step}
                        onChange={(e) => updateStep(index, e.target.value)}
                        placeholder="skill e.g. customize-opencode"
                        className="font-mono text-xs flex-1"
                        list="skill-options"
                      />
                      <div className="flex flex-col gap-0.5">
                        <button type="button" onClick={() => moveStep(index, -1)} className="text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={index === 0}>
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" onClick={() => moveStep(index, 1)} className="text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={index === steps.length - 1}>
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <button type="button" onClick={() => removeStep(index)} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <datalist id="skill-options">
                  {availableSkills.map((skill) => (
                    <option key={skill} value={skill} />
                  ))}
                </datalist>
                <Button type="button" variant="ghost" size="sm" onClick={addStep} className="gap-1 text-xs text-muted-foreground">
                  <Plus className="w-3.5 h-3.5" />
                  Add step
                </Button>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Additional template text</label>
                <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Optional extra instructions. Use $ARGUMENTS." className="min-h-[60px] font-mono text-xs" />
              </div>
            </>
          )}

          {type === 'command' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Template preview</label>
              <pre className="rounded-md bg-muted/40 border border-border p-2 text-[11px] text-foreground whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto">
                {type === 'command'
                  ? mode === 'steps'
                    ? buildCommandTemplate(steps, extra)
                    : rawTemplate || '(empty)'
                  : ''}
              </pre>
            </div>
          )}

          {type === 'command' && mode === 'template' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Template <span className="text-destructive">*</span></label>
              <Textarea value={rawTemplate} onChange={(e) => setRawTemplate(e.target.value)} placeholder="Paste the full prompt template. Use $ARGUMENTS, $1, $2..." className="min-h-[140px] font-mono text-xs" />
            </div>
          )}

          {type === 'command' && (
            <div className="flex flex-wrap sm:grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Agent (optional)</label>
                <Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="build" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Model (optional)</label>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic/claude-3-5-sonnet-20241022" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Top P (optional)</label>
                <Input value={topP} onChange={(e) => setTopP(e.target.value)} type="number" min="0" max="1" step="0.1" />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={subtask} onChange={(e) => setSubtask(e.target.checked)} className="accent-foreground" />
                Run as subtask
              </label>
            </div>
          )}

          {type === 'skill' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Skill content <span className="text-destructive">*</span></label>
              <Textarea value={skillBody} onChange={(e) => setSkillBody(e.target.value)} placeholder="SKILL.md body (frontmatter name/description added automatically)" className="min-h-[140px] font-mono text-xs" />
            </div>
          )}

          {type === 'tool' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Plugin script (.ts) <span className="text-destructive">*</span></label>
              <Textarea value={toolScript} onChange={(e) => setToolScript(e.target.value)} placeholder="Full TypeScript plugin definition using @opencode-ai/plugin's tool() helper" className="min-h-[160px] font-mono text-xs" />
              <p className="text-[10px] text-muted-foreground">Writes to {scope === 'global' ? `${GLOBAL_TARGET_DIR}/plugin` : '.opencode/plugin'} as `.ts`. Filename becomes the tool name.</p>
            </div>
          )}

          {type === 'agent' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Mode</label>
                <Select value={agentMode} onValueChange={(value: RegistryAgentMode) => setAgentMode(value)}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All (primary + subagent)</SelectItem>
                    <SelectItem value="subagent">Subagent</SelectItem>
                    <SelectItem value="primary">Primary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">System prompt <span className="text-destructive">*</span></label>
                <Textarea value={agentBody} onChange={(e) => setAgentBody(e.target.value)} placeholder="System prompt for the agent. Frontmatter (description/mode) is added automatically." className="min-h-[160px] font-mono text-xs" />
              </div>
            </div>
          )}

          {type === 'mcp' && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Server Type</label>
                <Select value={mcpType} onValueChange={(value: 'local' | 'remote') => setMcpType(value)}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local (Command)</SelectItem>
                    <SelectItem value="remote">Remote (HTTP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {mcpType === 'local' ? (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Command <span className="text-destructive">*</span></label>
                  <Input
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                    placeholder="npx @modelcontextprotocol/server-filesystem /tmp"
                    className="font-mono"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Server URL <span className="text-destructive">*</span></label>
                  <Input
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="http://localhost:3000/mcp"
                    className="font-mono"
                  />
                </div>
              )}

              {mcpType === 'local' && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Environment Variables</label>
                  {mcpEnvironment.map((env, index) => (
                    <div key={index} className="flex gap-1.5">
                      <Input
                        value={env.key}
                        onChange={(e) => {
                          const updated = [...mcpEnvironment]
                          updated[index].key = e.target.value
                          setMcpEnvironment(updated)
                        }}
                        placeholder="API_KEY"
                        className="font-mono text-xs"
                      />
                      <Input
                        value={env.value}
                        onChange={(e) => {
                          const updated = [...mcpEnvironment]
                          updated[index].value = e.target.value
                          setMcpEnvironment(updated)
                        }}
                        placeholder="value"
                        className="font-mono text-xs"
                      />
                      {mcpEnvironment.length > 1 && (
                        <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => setMcpEnvironment(mcpEnvironment.filter((_, i) => i !== index))}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setMcpEnvironment([...mcpEnvironment, { key: '', value: '' }])} className="gap-1 text-xs text-muted-foreground">
                    <Plus className="w-3.5 h-3.5" />
                    Add variable
                  </Button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Timeout (ms)</label>
                  <Input value={mcpTimeout} onChange={(e) => setMcpTimeout(e.target.value)} placeholder="5000" className="font-mono" />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Switch checked={mcpEnabled} onCheckedChange={setMcpEnabled} />
                  Enable on startup
                </label>
              </div>
            </div>
          )}

          {type !== 'mcp' && (
          <div className="text-[11px] text-muted-foreground">
            Target:{' '}
            <span className="font-mono">
              {scope === 'global'
                ? GLOBAL_TARGET_DIR
                : `${directory ? directory.split(/[\\/]/).pop() : 'project'} /.opencode`}
              /{type === 'tool' ? 'plugin' : type === 'skill' ? 'skill' : type === 'agent' ? 'agents' : 'command'}/{type === 'skill' ? `${name}/` : ''}...
            </span>
          </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => handleClose(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {editing ? 'Save' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
import { useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { registryApi, type RegistryType, type RegistryScope } from '@/api/registry'
import { settingsApi } from '@/api/settings'
import { showToast } from '@/lib/toast'

type Mode = 'steps' | 'template'

interface CreateCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  availableSkills?: string[]
  directory?: string
}

const TYPE_OPTIONS: { value: RegistryType; label: string }[] = [
  { value: 'command', label: 'Command' },
  { value: 'skill', label: 'Skill' },
  { value: 'tool', label: 'Tool' },
]

const SCOPE_OPTIONS: { value: RegistryScope; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' },
]

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

export function CreateCommandDialog({ open, onOpenChange, onCreated, availableSkills = [], directory }: CreateCommandDialogProps) {
  const [type, setType] = useState<RegistryType>('command')
  const [scope, setScope] = useState<RegistryScope>('global')
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
  const [saving, setSaving] = useState(false)

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

  const switchType = (next: RegistryType) => {
    setType(next)
    if (next === 'command') setScope('global')
  }

  const resolveContent = (): string => {
    switch (type) {
      case 'command':
        return mode === 'steps' ? buildCommandTemplate(steps, extra) : rawTemplate
      case 'skill':
        return skillBody
      case 'tool':
        return toolScript
    }
  }

  const handleSave = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      showToast.error('Name is required.')
      return
    }
    const content = resolveContent()
    if (!content.trim()) {
      showToast.error('Content is required.')
      return
    }

    setSaving(true)
    try {
      if (type === 'command') {
        const { defaultConfig, configs } = await settingsApi.getOpenCodeConfigs()
        const targetName = defaultConfig?.name ?? configs[0]?.name
        if (!targetName) {
          showToast.error('No OpenCode configuration to update. Create one first.')
          return
        }
        const record: Record<string, unknown> = { description: description.trim(), agent, model, subtask }
        if (topP) record.topP = Number(topP)
        const current = configs.find((c) => c.name === targetName)?.content ?? defaultConfig?.content ?? {}
        const existingCommands = (current.command as Record<string, unknown> | undefined) ?? {}
        const commands: Record<string, unknown> = { ...existingCommands, [trimmedName]: record }
        await settingsApi.updateOpenCodeConfig(targetName, { content: { ...current, command: commands } })
        showToast.success(`Command "${trimmedName}" saved to configuration "${targetName}".`)
      } else {
        if (scope === 'project' && !directory) {
          showToast.error('No project selected. Use Global scope or open a repo session.')
          return
        }
        await registryApi.register(
          {
            type,
            scope,
            name: trimmedName,
            description: description.trim(),
            content: content.trim(),
          },
          scope === 'project' ? directory : undefined
        )
        showToast.success(`${type === 'tool' ? 'Tool' : type === 'skill' ? 'Skill' : 'Command'} "${trimmedName}" registered (${scope}).`)
      }
      onCreated()
      reset()
      onOpenChange(false)
    } catch (err) {
      console.error('Failed to register:', err)
      showToast.error(`Failed to register ${type === 'tool' ? 'tool' : type === 'skill' ? 'skill' : 'command'}.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Register new opencode file</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {TYPE_OPTIONS.map((opt) => (
              <Button key={opt.value} type="button" size="sm" variant={type === opt.value ? 'secondary' : 'ghost'} onClick={() => switchType(opt.value)} className="text-xs h-7">
                {opt.label}
              </Button>
            ))}
            <div className="w-px h-5 bg-border mx-1" />
            {SCOPE_OPTIONS.map((opt) => (
              <Button key={opt.value} type="button" size="sm" variant={scope === opt.value ? 'secondary' : 'ghost'} onClick={() => setScope(opt.value)} className="text-xs h-7" disabled={type === 'command'}>
                {opt.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. ${type}`}
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
              <label className="text-xs text-muted-foreground">Tool script (.ts) <span className="text-destructive">*</span></label>
              <Textarea value={toolScript} onChange={(e) => setToolScript(e.target.value)} placeholder="Full TypeScript tool definition using @opencode-ai/plugin's tool() helper" className="min-h-[160px] font-mono text-xs" />
              <p className="text-[10px] text-muted-foreground">Writes to {scope === 'global' ? '~/.config/opencode/tools' : '.opencode/tools'} as `.ts`. Filename becomes the tool name.</p>
            </div>
          )}

          <div className="text-[11px] text-muted-foreground">
            Target:{' '}
            <span className="font-mono">
              {scope === 'global' ? '~/.config/opencode' : `${directory ? directory.split(/[\\/]/).pop() : 'project'} /.opencode`}
              /{type === 'tool' ? 'tools' : type}/{type === 'skill' ? `${name}/` : ''}...
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => handleClose(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
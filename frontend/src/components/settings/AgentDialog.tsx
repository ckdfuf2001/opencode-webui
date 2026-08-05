import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Agent, ApprovalType } from './agentTypes'
import { NOTIFY_PROMPT_BLOCK, hasNotifyPrompt, inferApprovalType } from './agentTypes'

const agentFormSchema = z.object({
  name: z.string().min(1, 'Agent name is required').regex(/^[a-z0-9-]+$/, 'Must be lowercase letters, numbers, and hyphens only'),
  description: z.string().optional(),
  prompt: z.string().min(1, 'Prompt is required'),
  mode: z.enum(['subagent', 'primary', 'all']),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  modelId: z.string().optional(),
  providerId: z.string().optional(),
  write: z.boolean(),
  edit: z.boolean(),
  bash: z.boolean(),
  webfetch: z.boolean(),
  editPermission: z.enum(['ask', 'allow', 'deny']),
  bashPermission: z.enum(['ask', 'allow', 'deny']),
  webfetchPermission: z.enum(['ask', 'allow', 'deny']),
  approvalType: z.enum(['general', 'auto', 'notify']),
  disable: z.boolean()
})

type AgentFormValues = z.infer<typeof agentFormSchema>

interface AgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string, agent: Agent) => void
  editingAgent?: { name: string; agent: Agent } | null
}

export function AgentDialog({ open, onOpenChange, onSubmit, editingAgent }: AgentDialogProps) {
  const editableAgent = editingAgent?.agent
  const initialType = inferApprovalType(editableAgent)
  const defaultPerm: 'ask' | 'allow' = initialType === 'general' ? 'ask' : 'allow'

  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: editingAgent?.name || '',
      description: editableAgent?.description || '',
      prompt: editableAgent?.prompt || '',
      mode: editableAgent?.mode || 'subagent',
      temperature: editableAgent?.temperature ?? 0.7,
      topP: editableAgent?.topP ?? 1,
      approvalType: initialType,
      modelId: editableAgent?.model?.modelID || '',
      providerId: editableAgent?.model?.providerID || '',
      write: editableAgent?.tools?.write ?? true,
      edit: editableAgent?.tools?.edit ?? true,
      bash: editableAgent?.tools?.bash ?? true,
      webfetch: editableAgent?.tools?.webfetch ?? true,
      editPermission: editableAgent?.permission?.edit ?? defaultPerm,
      bashPermission: typeof editableAgent?.permission?.bash === 'string' ? editableAgent.permission.bash : defaultPerm,
      webfetchPermission: editableAgent?.permission?.webfetch ?? defaultPerm,
      disable: editableAgent?.disable ?? false
    }
  })

  const handleApprovalTypeChange = (type: ApprovalType) => {
    const perm: 'ask' | 'allow' = type === 'general' ? 'ask' : 'allow'
    form.setValue('approvalType', type)
    form.setValue('editPermission', perm)
    form.setValue('bashPermission', perm)
    form.setValue('webfetchPermission', perm)
    if (type === 'notify') {
      const current = form.getValues('prompt').trim()
      if (!hasNotifyPrompt(current)) {
        form.setValue('prompt', current ? current + NOTIFY_PROMPT_BLOCK : NOTIFY_PROMPT_BLOCK.trim())
      }
    }
  }

  const handleSubmit = (values: AgentFormValues) => {
    const agent: Agent = {
      prompt: values.prompt,
      description: values.description || undefined,
      mode: values.mode,
      temperature: values.temperature,
      topP: values.topP,
      disable: values.disable,
      approvalType: values.approvalType,
      tools: {
        write: values.write,
        edit: values.edit,
        bash: values.bash,
        webfetch: values.webfetch
      },
      permission: {
        edit: values.editPermission,
        bash: values.bashPermission,
        webfetch: values.webfetchPermission
      }
    }

    if (values.approvalType === 'notify') {
      const prompt = values.prompt.trim()
      agent.prompt = hasNotifyPrompt(prompt) ? prompt : prompt ? prompt + NOTIFY_PROMPT_BLOCK : NOTIFY_PROMPT_BLOCK.trim()
    }

    if (values.modelId || values.providerId) {
      agent.model = {
        modelID: values.modelId || '',
        providerID: values.providerId || ''
      }
    }

    onSubmit(values.name, agent)
    form.reset()
    onOpenChange(false)
  }

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      form.reset()
    }
    onOpenChange(isOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingAgent ? 'Edit Agent' : 'Create Agent'}</DialogTitle>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Agent Name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="my-agent"
                      disabled={!!editingAgent}
                      className={editingAgent ? 'bg-muted' : ''}
                    />
                  </FormControl>
                  <FormDescription>
                    Use lowercase letters, numbers, and hyphens only
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Brief description of what the agent does"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Prompt</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="The system prompt that defines the agent's behavior and role"
                      rows={6}
                      className="font-mono text-sm"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="approvalType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Approval Type</FormLabel>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {([
                      ['general', '일반 대화 (Ask)'],
                      ['auto', '슈퍼 배치 (Auto)'],
                      ['notify', '알림 (Notify)'],
                    ] as [ApprovalType, string][]).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleApprovalTypeChange(value)}
                        className={`rounded-md border px-3 py-2 text-left text-sm ${
                          field.value === value
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-foreground hover:bg-muted'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <FormDescription>
                    {field.value === 'general' && '단계마다 확인하는 일반 대화 방식 (기본).'}
                    {field.value === 'auto' && '모든 도구를 자동 승인하여 확인 없이 배치 수행.'}
                    {field.value === 'notify' && '자동 수행하되 각 단계 결과를 사용자에게 보고.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mode</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="subagent">Subagent</SelectItem>
                        <SelectItem value="primary">Primary</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="temperature"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Temperature</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        onChange={(e) => field.onChange(parseFloat(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="topP"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Top P</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min="0"
                        max="1"
                        step="0.1"
                        onChange={(e) => field.onChange(parseFloat(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Model Configuration</div>
              <div className="flex flex-col sm:grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="modelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model ID</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="claude-3-5-sonnet-20241022"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="providerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Provider ID</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="anthropic"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Tools Configuration</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <FormField
                  control={form.control}
                  name="write"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="font-normal">Write</FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="edit"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="font-normal">Edit</FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="bash"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="font-normal">Bash</FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="webfetch"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="font-normal">Web Fetch</FormLabel>
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">Permissions</div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <FormField
                  control={form.control}
                  name="editPermission"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Edit</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ask">Ask</SelectItem>
                          <SelectItem value="allow">Allow</SelectItem>
                          <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="bashPermission"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Bash</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ask">Ask</SelectItem>
                          <SelectItem value="allow">Allow</SelectItem>
                          <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="webfetchPermission"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Web Fetch</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ask">Ask</SelectItem>
                          <SelectItem value="allow">Allow</SelectItem>
                          <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="disable"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Disable agent</FormLabel>
                    <FormDescription>
                      Prevent this agent from being used
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button 
                type="submit"
                disabled={!form.formState.isValid}
              >
                {editingAgent ? 'Update' : 'Create'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

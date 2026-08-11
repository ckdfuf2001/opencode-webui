export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'OpenCode WebUI Backend API',
    version: '2.0.0',
    description:
      'Internal REST API of the OpenCode WebUI backend. The backend owns the workspace, SQLite database, repo/worktree lifecycle, document conversion, the OpenCode server child process, and the scheduler. All OpenCode chat traffic is proxied through /api/opencode/* (see the separate OpenCode spec served at /api/opencode/doc).',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'health', description: 'Health and process status' },
    { name: 'repos', description: 'Repository and worktree management' },
    { name: 'settings', description: 'User preferences, OpenCode configs, custom commands' },
    { name: 'schedules', description: 'Scheduled prompt/command runner' },
    { name: 'permission-rules', description: 'Auto-approve permission rules per repo' },
    { name: 'files', description: 'File browser and upload/download' },
    { name: 'providers', description: 'Provider credential management' },
    { name: 'registry', description: 'Register opencode config files (command/skill/tool/agent)' },
    { name: 'preview', description: 'Document preview, text extraction, and in-place editing' },
    { name: 'tts', description: 'Text-to-speech synthesis' },
    { name: 'opencode', description: 'Proxy to the OpenCode server' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['health'],
        summary: 'Check backend health',
        responses: {
          '200': {
            description: 'Health status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
                    timestamp: { type: 'string' },
                    database: { type: 'string', enum: ['connected', 'disconnected'] },
                    opencode: { type: 'string', enum: ['healthy', 'unhealthy'] },
                    opencodePort: { type: 'number' },
                  },
                },
              },
            },
          },
          '503': { description: 'Backend unhealthy' },
        },
      },
    },
    '/api/health/processes': {
      get: {
        tags: ['health'],
        summary: 'Check OpenCode server process status',
        responses: {
          '200': {
            description: 'Process status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    opencode: {
                      type: 'object',
                      properties: {
                        port: { type: 'number' },
                        healthy: { type: 'boolean' },
                      },
                    },
                    timestamp: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/network-info': {
      get: {
        tags: ['health'],
        summary: 'List reachable API URLs on this machine',
        responses: {
          '200': {
            description: 'Network info',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    host: { type: 'string' },
                    port: { type: 'number' },
                    requestHost: { type: 'string' },
                    protocol: { type: 'string' },
                    availableIps: { type: 'array', items: { type: 'string' } },
                    apiUrls: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/repos': {
      post: {
        tags: ['repos'],
        summary: 'Clone a remote repo or initialize a local folder',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  repoUrl: { type: 'string' },
                  localPath: { type: 'string' },
                  branch: { type: 'string' },
                  openCodeConfigName: { type: 'string' },
                  useWorktree: { type: 'boolean' },
                },
                required: [],
                oneOf: [{ required: ['repoUrl'] }, { required: ['localPath'] }],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Created repo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Repo' } } } },
          '400': { description: 'repoUrl or localPath required' },
          '500': { description: 'Clone/init failed' },
        },
      },
      get: {
        tags: ['repos'],
        summary: 'List all repos with current branch',
        responses: {
          '200': {
            description: 'Repo list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Repo' } } } },
          },
        },
      },
    },
    '/api/repos/{id}': {
      get: {
        tags: ['repos'],
        summary: 'Get a single repo',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Repo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Repo' } } } },
          '404': { description: 'Repo not found' },
        },
      },
      delete: {
        tags: ['repos'],
        summary: 'Delete a repo and its files',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '404': { description: 'Repo not found' },
        },
      },
    },
    '/api/repos/{id}/pull': {
      post: {
        tags: ['repos'],
        summary: 'Pull latest changes',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Updated repo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Repo' } } } },
        },
      },
    },
    '/api/repos/{id}/config/switch': {
      post: {
        tags: ['repos'],
        summary: 'Switch the active OpenCode config for a repo',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { configName: { type: 'string' } }, required: ['configName'] },
            },
          },
        },
        responses: {
          '200': { description: 'Updated repo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Repo' } } } },
          '400': { description: 'configName required' },
          '404': { description: 'Repo or config not found' },
        },
      },
    },
    '/api/repos/{id}/branch/switch': {
      post: {
        tags: ['repos'],
        summary: 'Switch branch',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
            },
          },
        },
        responses: {
          '200': { description: 'Updated repo with current branch', content: { 'application/json': { schema: { $ref: '#/components/schemas/Repo' } } } },
          '400': { description: 'branch required' },
          '404': { description: 'Repo not found' },
        },
      },
    },
    '/api/repos/{id}/branches': {
      get: {
        tags: ['repos'],
        summary: 'List local and remote branches',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'Branches',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    local: { type: 'array', items: { type: 'string' } },
                    remote: { type: 'array', items: { type: 'string' } },
                    current: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/repos/{id}/git/status': {
      get: {
        tags: ['repos'],
        summary: 'Git status of a repo',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Git status', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitStatus' } } } },
        },
      },
    },
    '/api/repos/{id}/git/diff': {
      get: {
        tags: ['repos'],
        summary: 'Unified diff for a single file',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Repo-relative file path' },
        ],
        responses: {
          '200': { description: 'File diff', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileDiff' } } } },
          '400': { description: 'path query parameter is required' },
        },
      },
    },
    '/api/settings': {
      get: {
        tags: ['settings'],
        summary: 'Get user settings',
        parameters: [{ name: 'userId', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Settings' } } } },
        },
      },
      patch: {
        tags: ['settings'],
        summary: 'Partially update preferences (restarts OpenCode server on bin path change)',
        parameters: [{ name: 'userId', in: 'query', schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { preferences: { type: 'object' } }, required: ['preferences'] },
            },
          },
        },
        responses: {
          '200': { description: 'Updated settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Settings' } } } },
          '400': { description: 'Invalid settings data' },
        },
      },
      delete: {
        tags: ['settings'],
        summary: 'Reset settings to defaults',
        parameters: [{ name: 'userId', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Reset settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Settings' } } } },
        },
      },
    },
    '/api/settings/opencode-configs': {
      get: {
        tags: ['settings'],
        summary: 'List OpenCode configs',
        responses: {
          '200': { description: 'Configs', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenCodeConfigList' } } } },
        },
      },
      post: {
        tags: ['settings'],
        summary: 'Create an OpenCode config',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  content: { type: 'object' },
                  isDefault: { type: 'boolean' },
                },
                required: ['name', 'content'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Created config', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenCodeConfig' } } } },
          '400': { description: 'Invalid config data' },
        },
      },
    },
    '/api/settings/opencode-configs/default': {
      get: {
        tags: ['settings'],
        summary: 'Get the default OpenCode config',
        responses: {
          '200': { description: 'Default config', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenCodeConfig' } } } },
          '404': { description: 'No default config found' },
        },
      },
    },
    '/api/settings/opencode-configs/{name}': {
      put: {
        tags: ['settings'],
        summary: 'Update an OpenCode config (restarts OpenCode server if MCP changed)',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { content: { type: 'object' }, isDefault: { type: 'boolean' } },
                required: ['content'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated config', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenCodeConfig' } } } },
          '404': { description: 'Config not found' },
        },
      },
      delete: {
        tags: ['settings'],
        summary: 'Delete an OpenCode config',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '404': { description: 'Config not found' },
        },
      },
    },
    '/api/settings/opencode-configs/{name}/set-default': {
      post: {
        tags: ['settings'],
        summary: 'Mark a config as the default',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Default config', content: { 'application/json': { schema: { $ref: '#/components/schemas/OpenCodeConfig' } } } },
          '404': { description: 'Config not found' },
        },
      },
    },
    '/api/settings/opencode-restart': {
      post: {
        tags: ['settings'],
        summary: 'Manually restart the OpenCode server',
        responses: {
          '200': { description: 'Restart requested', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
        },
      },
    },
    '/api/settings/custom-commands': {
      get: {
        tags: ['settings'],
        summary: 'List custom slash commands',
        responses: {
          '200': { description: 'Commands', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/CustomCommand' } } } } },
        },
      },
      post: {
        tags: ['settings'],
        summary: 'Create a custom slash command',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  promptTemplate: { type: 'string' },
                  steps: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'description', 'promptTemplate'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Created command', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomCommand' } } } },
          '400': { description: 'Invalid command data' },
          '409': { description: 'Command already exists' },
        },
      },
    },
    '/api/settings/custom-commands/{name}': {
      put: {
        tags: ['settings'],
        summary: 'Update a custom slash command',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  promptTemplate: { type: 'string' },
                  steps: { type: 'array', items: { type: 'string' } },
                },
                required: ['description', 'promptTemplate'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated command', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomCommand' } } } },
          '404': { description: 'Command not found' },
        },
      },
      delete: {
        tags: ['settings'],
        summary: 'Delete a custom slash command',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '404': { description: 'Command not found' },
        },
      },
    },
    '/api/schedules': {
      get: {
        tags: ['schedules'],
        summary: 'List schedules',
        parameters: [{ name: 'repoId', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Schedules', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Schedule' } } } } },
        },
      },
      post: {
        tags: ['schedules'],
        summary: 'Create a schedule',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  repoId: { type: 'integer' },
                  name: { type: 'string' },
                  action: { type: 'string', enum: ['command', 'chat'] },
                  command: { type: 'string' },
                  prompt: { type: 'string' },
                  cron: { type: 'string' },
                  enabled: { type: 'boolean' },
                  activeFrom: { type: 'integer' },
                  activeUntil: { type: 'integer' },
                  agent: { type: 'string' },
                },
                required: ['repoId', 'name', 'action', 'cron'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created schedule', content: { 'application/json': { schema: { $ref: '#/components/schemas/Schedule' } } } },
          '400': { description: 'Invalid schedule data' },
          '404': { description: 'Repo not found' },
        },
      },
    },
    '/api/schedules/{id}': {
      put: {
        tags: ['schedules'],
        summary: 'Update a schedule',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  action: { type: 'string', enum: ['command', 'chat'] },
                  command: { type: 'string' },
                  prompt: { type: 'string' },
                  cron: { type: 'string' },
                  enabled: { type: 'boolean' },
                  activeFrom: { type: 'integer' },
                  activeUntil: { type: 'integer' },
                  agent: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated schedule', content: { 'application/json': { schema: { $ref: '#/components/schemas/Schedule' } } } },
          '404': { description: 'Schedule not found' },
        },
      },
      delete: {
        tags: ['schedules'],
        summary: 'Delete a schedule',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '404': { description: 'Schedule not found' },
        },
      },
    },
    '/api/schedules/{id}/run': {
      post: {
        tags: ['schedules'],
        summary: 'Run a schedule immediately',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'Run started',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    sessionID: { type: 'string' },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': { description: 'Schedule not found' },
          '500': { description: 'Run failed' },
        },
      },
    },
    '/api/permission-rules': {
      get: {
        tags: ['permission-rules'],
        summary: 'List permission rules',
        parameters: [{ name: 'repoId', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Rules', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PermissionRule' } } } } },
        },
      },
      post: {
        tags: ['permission-rules'],
        summary: 'Create a permission rule',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  repoId: { type: 'integer' },
                  permission: { type: 'string' },
                  pattern: { type: 'string' },
                },
                required: ['repoId', 'permission', 'pattern'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created rule', content: { 'application/json': { schema: { $ref: '#/components/schemas/PermissionRule' } } } },
          '400': { description: 'Invalid permission rule data' },
          '404': { description: 'Repo not found' },
        },
      },
    },
    '/api/permission-rules/{id}': {
      delete: {
        tags: ['permission-rules'],
        summary: 'Delete a permission rule',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '404': { description: 'Permission rule not found' },
        },
      },
    },
    '/api/files/{path}': {
      parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Relative path under the workspace' }],
      get: {
        tags: ['files'],
        summary: 'Read a file or list a directory',
        parameters: [
          { name: 'download', in: 'query', schema: { type: 'string' }, description: 'true to download the raw bytes' },
          { name: 'raw', in: 'query', schema: { type: 'string' }, description: 'true to return raw file content' },
          { name: 'startLine', in: 'query', schema: { type: 'integer' } },
          { name: 'endLine', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'File info, directory listing, raw bytes, or line range' },
          '400': { description: 'Invalid line range parameters' },
          '500': { description: 'File read failed' },
        },
      },
      post: {
        tags: ['files'],
        summary: 'Upload a file (multipart/form-data, field "file")',
        responses: {
          '200': { description: 'Upload result' },
          '400': { description: 'No file provided or type not allowed' },
        },
      },
      put: {
        tags: ['files'],
        summary: 'Create a file or folder',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['file', 'folder'] },
                  content: { type: 'string' },
                },
                required: ['type'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Created file/folder info' },
          '400': { description: 'Invalid request' },
        },
      },
      delete: {
        tags: ['files'],
        summary: 'Delete a file or folder',
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
        },
      },
      patch: {
        tags: ['files'],
        summary: 'Apply line patches or rename/move',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  patches: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['replace', 'insert', 'delete'] },
                        startLine: { type: 'integer' },
                        endLine: { type: 'integer' },
                        content: { type: 'string' },
                      },
                    },
                  },
                  newPath: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Patched file info or { success, totalLines }' },
        },
      },
    },
    '/api/providers/credentials': {
      get: {
        tags: ['providers'],
        summary: 'List providers that have credentials',
        responses: {
          '200': {
            description: 'Providers',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { providers: { type: 'array', items: { type: 'string' } } } },
              },
            },
          },
        },
      },
    },
    '/api/providers/{id}/credentials': {
      post: {
        tags: ['providers'],
        summary: 'Set a provider API key',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { apiKey: { type: 'string' } }, required: ['apiKey'] },
            },
          },
        },
        responses: {
          '200': { description: 'Set', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '400': { description: 'Invalid request data' },
        },
      },
      delete: {
        tags: ['providers'],
        summary: 'Delete a provider API key',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
        },
      },
    },
    '/api/providers/{id}/credentials/status': {
      get: {
        tags: ['providers'],
        summary: 'Check whether a provider has credentials',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Credential status',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { hasCredentials: { type: 'boolean' } } },
              },
            },
          },
        },
      },
    },
    '/api/registry': {
      get: {
        tags: ['registry'],
        summary: 'List registered opencode files (command/skill/tool/agent)',
        parameters: [{ name: 'directory', in: 'query', schema: { type: 'string' }, description: 'Repo directory for project scope' }],
        responses: {
          '200': {
            description: 'List of registered files',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string', enum: ['command', 'skill', 'tool', 'agent'] },
                          scope: { type: 'string', enum: ['global', 'project'] },
                          name: { type: 'string' },
                          description: { type: 'string' },
                          content: { type: 'string' },
                          mode: { type: 'string' },
                          path: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '500': { description: 'Failed to list registry items' },
        },
      },
      post: {
        tags: ['registry'],
        summary: 'Register an opencode file (command/skill/tool/agent)',
        parameters: [{ name: 'directory', in: 'query', schema: { type: 'string' }, description: 'Repo directory for project scope' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['command', 'skill', 'tool', 'agent'] },
                  scope: { type: 'string', enum: ['global', 'project'] },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  content: { type: 'string' },
                  mode: { type: 'string', enum: ['all', 'subagent', 'primary'] },
                },
                required: ['type', 'scope', 'name', 'content'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Registered file',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    type: { type: 'string' },
                    scope: { type: 'string' },
                    name: { type: 'string' },
                    path: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid data or name' },
        },
      },
    },
    '/api/registry/{type}/{scope}/{name}': {
      put: {
        tags: ['registry'],
        summary: 'Update an existing registered opencode file (supports rename via body name)',
        parameters: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['command', 'skill', 'tool', 'agent'] } },
          { name: 'scope', in: 'path', required: true, schema: { type: 'string', enum: ['global', 'project'] } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'directory', in: 'query', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  content: { type: 'string' },
                  mode: { type: 'string', enum: ['all', 'subagent', 'primary'] },
                },
                required: ['name', 'content'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated file',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    type: { type: 'string' },
                    scope: { type: 'string' },
                    name: { type: 'string' },
                    path: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid type/scope/name or update failed' },
        },
      },
      delete: {
        tags: ['registry'],
        summary: 'Delete a registered opencode file',
        parameters: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['command', 'skill', 'tool', 'agent'] } },
          { name: 'scope', in: 'path', required: true, schema: { type: 'string', enum: ['global', 'project'] } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'directory', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
          '400': { description: 'Invalid type/scope or delete failed' },
        },
      },
    },
    '/api/preview/edit': {
      post: {
        tags: ['preview'],
        summary: 'Edit an Office document in place (replace / insert_after / insert_before / append / prepend / delete)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  operations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        op: { type: 'string', enum: ['replace', 'insert_after', 'insert_before', 'append', 'prepend', 'delete'] },
                        find: { type: 'string' },
                        replace: { type: 'string' },
                        text: { type: 'string' },
                        occurrence: { type: 'integer' },
                      },
                    },
                  },
                },
                required: ['path', 'operations'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Edit result' },
          '400': { description: 'Invalid request body' },
          '500': { description: 'Edit failed' },
        },
      },
    },
    '/api/preview/extract': {
      post: {
        tags: ['preview'],
        summary: 'Extract readable text from an Office/PDF document',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
          },
        },
        responses: {
          '200': {
            description: 'Extracted text',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { text: { type: 'string' }, fileName: { type: 'string' } } },
              },
            },
          },
          '400': { description: 'Missing path' },
          '500': { description: 'Extraction failed' },
        },
      },
    },
    '/api/preview/pdf': {
      get: {
        tags: ['preview'],
        summary: 'Convert an Office document to PDF (via local desktop Office COM)',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'refresh', in: 'query', schema: { type: 'string' }, description: '1 to re-convert ignoring cache' },
        ],
        responses: {
          '200': { description: 'PDF bytes', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
          '400': { description: 'Missing path' },
          '500': { description: 'Conversion failed' },
        },
      },
    },
    '/api/tts/synthesize': {
      post: {
        tags: ['tts'],
        summary: 'Synthesize speech to MP3 (requires TTS enabled and configured)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { text: { type: 'string', maxLength: 4096 } }, required: ['text'] },
            },
          },
        },
        responses: {
          '200': { description: 'MP3 audio', content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } } },
          '400': { description: 'TTS disabled/not configured or invalid request' },
          '500': { description: 'Synthesis failed' },
        },
      },
    },
    '/api/tts/status': {
      get: {
        tags: ['tts'],
        summary: 'TTS feature status',
        responses: {
          '200': {
            description: 'TTS status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    configured: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/opencode/{path}': {
      parameters: [{ name: 'path', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['opencode'],
        summary: 'Proxy GET to the OpenCode server (sessions, messages, config, /doc, /mcp, ...)',
        responses: { '200': { description: 'Proxied response' } },
      },
      post: {
        tags: ['opencode'],
        summary: 'Proxy POST to the OpenCode server (session create, prompt, permission reply, ...)',
        responses: { '200': { description: 'Proxied response' } },
      },
      patch: {
        tags: ['opencode'],
        summary: 'Proxy PATCH to the OpenCode server',
        responses: { '200': { description: 'Proxied response' } },
      },
      delete: {
        tags: ['opencode'],
        summary: 'Proxy DELETE to the OpenCode server',
        responses: { '200': { description: 'Proxied response' } },
      },
    },
    '/api/opencode/event': {
      get: {
        tags: ['opencode'],
        summary: 'SSE event stream for a directory',
        parameters: [{ name: 'directory', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'SSE stream' } },
      },
    },
    '/api/opencode/global/event': {
      get: {
        tags: ['opencode'],
        summary: 'Global SSE event stream across all directories',
        responses: { '200': { description: 'SSE stream' } },
      },
    },
  },
  components: {
    schemas: {
      Success: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
      Repo: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          repoUrl: { type: 'string' },
          localPath: { type: 'string' },
          fullPath: { type: 'string' },
          branch: { type: 'string' },
          currentBranch: { type: 'string' },
          defaultBranch: { type: 'string' },
          cloneStatus: { type: 'string', enum: ['cloning', 'ready', 'error'] },
          clonedAt: { type: 'integer' },
          lastPulled: { type: 'integer' },
          openCodeConfigName: { type: 'string' },
          isWorktree: { type: 'boolean' },
          isLocal: { type: 'boolean' },
        },
      },
      GitStatus: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          ahead: { type: 'integer' },
          behind: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                status: { type: 'string', enum: ['modified', 'added', 'deleted', 'renamed', 'untracked', 'copied'] },
              },
            },
          },
        },
      },
      FileDiff: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string' },
          additions: { type: 'integer' },
          deletions: { type: 'integer' },
        },
      },
      Settings: {
        type: 'object',
        properties: {
          preferences: { type: 'object' },
          updatedAt: { type: 'integer' },
        },
      },
      OpenCodeConfig: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          content: { type: 'object' },
          isDefault: { type: 'boolean' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
        },
      },
      OpenCodeConfigList: {
        type: 'object',
        properties: {
          configs: { type: 'array', items: { $ref: '#/components/schemas/OpenCodeConfig' } },
          defaultConfig: { $ref: '#/components/schemas/OpenCodeConfig' },
        },
      },
      CustomCommand: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          promptTemplate: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
      Schedule: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          repoId: { type: 'integer' },
          name: { type: 'string' },
          action: { type: 'string', enum: ['command', 'chat'] },
          command: { type: 'string' },
          prompt: { type: 'string' },
          cron: { type: 'string' },
          enabled: { type: 'boolean' },
          lastRunAt: { type: 'integer' },
          activeFrom: { type: 'integer' },
          activeUntil: { type: 'integer' },
          agent: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
        },
      },
      PermissionRule: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          repoId: { type: 'integer' },
          permission: { type: 'string' },
          pattern: { type: 'string' },
          createdAt: { type: 'integer' },
        },
      },
    },
  },
} as const

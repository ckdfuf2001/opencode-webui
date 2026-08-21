import { useState, useMemo, useCallback } from 'react'
import { Search, type LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'

export interface ResourceItem<T> {
  id: string
  name: string
  description?: string
  icon?: LucideIcon
  badges?: { label: string; className: string }[]
  metadata?: Record<string, string | number | boolean | undefined>
  preview?: string
  disabled?: boolean
  data?: T
}

export interface ResourceGroup<T> {
  id: string
  label: string
  icon?: LucideIcon
  items: ResourceItem<T>[]
}

interface ResourceEditorProps<T> {
  groups: ResourceGroup<T>[]
  onItemClick?: (item: ResourceItem<T>) => void
  onItemEdit?: (item: ResourceItem<T>) => void
  editLabel?: (item: ResourceItem<T>) => string
  onItemDelete?: (item: ResourceItem<T>) => void
  emptyMessage?: string
  emptyIcon?: LucideIcon
  searchPlaceholder?: string
  showSearch?: boolean
  isLoading?: boolean
}

export function ResourceEditor<T>({
  groups,
  onItemClick,
  onItemEdit,
  editLabel,
  onItemDelete,
  emptyMessage = 'No items configured.',
  emptyIcon,
  searchPlaceholder = 'Search...',
  showSearch = true,
  isLoading = false,
}: ResourceEditorProps<T>) {
  const [query, setQuery] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.description?.toLowerCase().includes(q) ||
            Object.values(item.metadata || {}).some(
              (v) => String(v).toLowerCase().includes(q),
            ),
        ),
      }))
      .filter((group) => group.items.length > 0)
  }, [groups, query])

  const handleItemClick = useCallback(
    (item: ResourceItem<T>) => {
      setSelectedItemId(item.id)
      onItemClick?.(item)
    },
    [onItemClick],
  )

  const EmptyIcon = emptyIcon

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="h-8 w-8 animate-spin text-muted-foreground border-4 border-primary/30 rounded-full border-t-transparent" />
      </div>
    )
  }

  const hasItems = groups.length > 0 && groups.some((g) => g.items.length > 0)

  if (!hasItems) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center">
        {EmptyIcon && <EmptyIcon className="h-8 w-8 mb-2 text-muted-foreground/40" />}
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  if (filteredGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center">
        {EmptyIcon && <EmptyIcon className="h-8 w-8 mb-2 text-muted-foreground/40" />}
        <p className="text-sm text-muted-foreground">No matches for "{query}"</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {showSearch && (
        <div className="flex-shrink-0 px-3 py-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 pr-3 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
        <div className="space-y-1">
          {filteredGroups.map((group) => {
            return (
              <div key={group.id} className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center gap-2 rounded-md border transition-colors ${
                      selectedItemId === item.id ? 'bg-muted/40 border-border' : 'border-transparent hover:bg-muted/40'
                    }`}
                  >
                    <button
                      type="button"
                      className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left rounded-md min-w-0"
                      disabled={item.disabled}
                      onClick={() => handleItemClick(item)}
                    >
                      {item.icon && <item.icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                      <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">
                        {item.name}
                      </span>
                      {item.badges && item.badges.map((badge, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0">
                          {badge.label}
                        </span>
                      ))}
                    </button>
                    {(onItemEdit || onItemDelete) && selectedItemId === item.id && (
                      <div className="flex items-center gap-1 pr-1 flex-shrink-0">
                        {onItemEdit && (
                          <button
                            type="button"
                            onClick={() => onItemEdit(item)}
                            className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          >
{editLabel ? editLabel(item) : 'Edit'}
                          </button>
                        )}
                        {onItemDelete && (
                          <button
                            type="button"
                            onClick={() => onItemDelete(item)}
                            className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export interface ResourceEditorHeaderProps {
  title: string
  subtitle?: string
  onCreate?: () => void
  createLabel?: string
  isCreating?: boolean
  isLoading?: boolean
  extraActions?: React.ReactNode
}

export function ResourceEditorHeader({
  title,
  subtitle,
  onCreate,
  createLabel = 'New',
  isCreating = false,
  isLoading = false,
  extraActions,
}: ResourceEditorHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {extraActions}
        {onCreate && (
          <button className="h-6 gap-1" onClick={onCreate} disabled={isCreating || isLoading}>
            <span className="h-4 w-4">+</span>
            <span className="text-xs">{createLabel}</span>
          </button>
        )}
      </div>
    </div>
  )
}
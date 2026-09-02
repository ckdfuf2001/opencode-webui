import { useState, useMemo, Fragment } from "react";
import { useSessions, useDeleteSession, useSessionStatusMap, useCreateSession } from "@/hooks/useOpenCode";
import { useNavigate } from "react-router-dom";
import { useOpencodeHealth } from "@/hooks/useOpencodeHealth";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { Trash2, GitBranch, Clock, Search, MoreHorizontal, ShieldAlert, Loader2, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface SessionListProps {
  opcodeUrl: string;
  directory?: string;
  activeSessionID?: string;
  onSelectSession: (sessionID: string) => void;
  sessionHrefBase?: string;
}

interface SessionNode {
  session: {
    id: string;
    title?: string;
    parentID?: string;
    time: { updated: number };
  };
  children: SessionNode[];
}

export const SessionList = ({
  opcodeUrl,
  directory,
  activeSessionID,
  onSelectSession,
  sessionHrefBase,
}: SessionListProps) => {
  const { data: sessions, isLoading } = useSessions(opcodeUrl, directory);
  const deleteSession = useDeleteSession(opcodeUrl, directory);
  const { data: dbStatuses, isError: statusError, isFetching: statusFetching } = useSessionStatusMap();
  const { data: opencodeHealthy, isError: healthError, isFetching: healthFetching } = useOpencodeHealth();
  const isConnected = !healthError && !!opencodeHealthy && !statusError && !!dbStatuses;
  const isReconnecting = (healthError && healthFetching) || (statusError && statusFetching) || (!opencodeHealthy && !healthError);
  const navigate = useNavigate();
  const createSession = useCreateSession(opcodeUrl, directory);
  const dbBusyIds = useMemo(() => {
    const set = new Set<string>();
    for (const entry of dbStatuses ?? []) {
      if (entry.status === "busy") set.add(entry.sessionId);
    }
    return set;
  }, [dbStatuses]);
  const dbPendingCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const entry of dbStatuses ?? []) {
      if (entry.pendingPermissions > 0) map[entry.sessionId] = entry.pendingPermissions;
    }
    return map;
  }, [dbStatuses]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<
    string | string[] | null
  >(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    new Set(),
  );
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    new Set(),
  );

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!searchQuery.trim()) return sessions;

    const query = searchQuery.toLowerCase();
    return sessions.filter((session) =>
      (session.title || "Untitled Session").toLowerCase().includes(query),
    );
  }, [sessions, searchQuery]);

  const sessionTree = useMemo(() => {
    const nodes = new Map<string, SessionNode>();
    for (const s of filteredSessions) {
      nodes.set(s.id, { session: s, children: [] });
    }
    const roots: SessionNode[] = [];
    for (const node of nodes.values()) {
      const parentID = node.session.parentID;
      const parent = parentID ? nodes.get(parentID) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortRecursive = (list: SessionNode[]) => {
      list.sort((a, b) => b.session.time.updated - a.session.time.updated);
      for (const item of list) sortRecursive(item.children);
    };
    sortRecursive(roots);
    return roots;
  }, [filteredSessions]);

  const visibleSessionIDs = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: SessionNode[]) => {
      for (const node of nodes) {
        ids.add(node.session.id);
        walk(node.children);
      }
    };
    walk(sessionTree);
    return ids;
  }, [sessionTree]);

  const toggleExpand = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const collectSubtreeIDs = (node: SessionNode): string[] => {
    return [node.session.id, ...node.children.flatMap(collectSubtreeIDs)];
  };

  const getSubtreeSelectionState = (node: SessionNode) => {
    const subtreeIDs = collectSubtreeIDs(node);
    const selectedCount = subtreeIDs.filter((id) => selectedSessions.has(id)).length;
    if (selectedCount === subtreeIDs.length) return true;
    if (selectedCount > 0) return "indeterminate" as const;
    return false;
  };

  const toggleSubtreeSelection = (node: SessionNode, selected: boolean) => {
    const subtreeIDs = collectSubtreeIDs(node);
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (selected) {
        for (const id of subtreeIDs) next.add(id);
      } else {
        for (const id of subtreeIDs) next.delete(id);
      }
      return next;
    });
  };

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading sessions...</div>;
  }

  const handleDelete = (
    sessionId: string,
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    setSessionToDelete(sessionId);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async (withIndex?: boolean) => {
    if (sessionToDelete) {
      const wi = withIndex ?? true
      const ids = Array.isArray(sessionToDelete) ? sessionToDelete : [sessionToDelete]
      await deleteSession.mutateAsync({ ids, withIndex: wi } as any);
      setDeleteDialogOpen(false);
      setSessionToDelete(null);
      setSelectedSessions(new Set());
    }
  };

  const cancelDelete = () => {
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
  };

  const toggleSessionSelection = (sessionId: string, selected: boolean) => {
    const newSelected = new Set(selectedSessions);
    if (selected) {
      newSelected.add(sessionId);
    } else {
      newSelected.delete(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  const toggleSelectAll = () => {
    if (!filteredSessions || filteredSessions.length === 0) return;
    
    const allFilteredSelected = filteredSessions.every((session) =>
      selectedSessions.has(session.id),
    );

    if (allFilteredSelected) {
      setSelectedSessions(new Set());
    } else {
      const filteredIds = filteredSessions.map((s) => s.id);
      setSelectedSessions(new Set([...selectedSessions, ...filteredIds]));
    }
  };

  const handleBulkDelete = () => {
    if (selectedSessions.size > 0) {
      setSessionToDelete(Array.from(selectedSessions));
      setDeleteDialogOpen(true);
    }
  };

  const renderSessionNode = (node: SessionNode) => {
    const session = node.session;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedSessions.has(session.id);
    const isOrphan = !!session.parentID && !visibleSessionIDs.has(session.parentID);
    const subtreeSelection = getSubtreeSelectionState(node);

    return (
      <Fragment key={session.id}>
        <Card
          className={`p-3 cursor-pointer transition-all ${
            selectedSessions.has(session.id)
              ? "border-blue-500 shadow-lg shadow-blue-900/30 bg-muted"
              : activeSessionID === session.id
                ? "bg-muted border-border"
                : "bg-card border-border hover:bg-muted/60 hover:border-ring"
          } hover:shadow-lg`}
          onClick={(e) => {
            if ((e.ctrlKey || e.metaKey) && sessionHrefBase) {
              e.preventDefault();
              window.open(`${window.location.origin}${sessionHrefBase}/${session.id}`, '_blank');
              return;
            }
            onSelectSession(session.id);
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 flex-1 min-w-0">
              <Checkbox
                checked={subtreeSelection}
                onCheckedChange={(checked) => {
                  if (hasChildren) {
                    toggleSubtreeSelection(node, checked === true);
                  } else {
                    toggleSessionSelection(session.id, checked === true);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                className="w-5 h-5 flex-shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {hasChildren && (
                    <button
                      className="h-4 w-4 p-0 text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(session.id);
                      }}
                      title={isExpanded ? "Collapse sub-sessions" : "Expand sub-sessions"}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                  <h3 className="text-sm font-medium text-foreground truncate">
                    {session.title || "Untitled Session"}
                  </h3>
                  {dbBusyIds.has(session.id) ? (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-500 bg-blue-500/10 border border-blue-500/30 rounded-full px-2 py-0.5 flex-shrink-0"
                      title="LLM is answering"
                    >
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Working
                    </span>
                  ) : null}
                  {dbPendingCounts[session.id] ? (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 flex-shrink-0"
                      title={`${dbPendingCounts[session.id]} permission request(s) awaiting approval`}
                    >
                      <ShieldAlert className="w-3 h-3" />
                      {dbPendingCounts[session.id]}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {isOrphan && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" />
                      Forked
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDistanceToNow(new Date(session.time.updated), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              </div>
            </div>
            <button
              className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400 bg-transparent border-none cursor-pointer"
              onClick={(e) => handleDelete(session.id, e)}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </Card>
        {hasChildren && isExpanded && (
          <div className="ml-6 border-l border-border pl-3 flex flex-col gap-2">
            {node.children.map((child) => renderSessionNode(child))}
          </div>
        )}
      </Fragment>
    );
  };

  const handleCreateSession = async () => {
    try {
      const session = await createSession.mutateAsync({} as never)
      if (session?.id) {
        const base = sessionHrefBase ?? (directory ? `/repos/${directory.split(/[\\/]/).pop()}/sessions` : '/session')
        // use onSelectSession if provided, otherwise navigate
        if (onSelectSession) onSelectSession(session.id)
        else navigate(`${base}/${session.id}`)
      }
    } catch {}
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex-shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1.5 shrink-0 h-8 px-2">
            <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${isConnected ? "bg-green-500" : isReconnecting ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`} />
            <span className="text-xs text-muted-foreground hidden sm:inline">{isConnected ? "Connected" : isReconnecting ? "Reconnecting..." : "Disconnected"}</span>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          {filteredSessions && filteredSessions.length > 0 && (
            <Button
              onClick={toggleSelectAll}
              variant={selectedSessions.size > 0 ? "default" : "outline"}
              className="whitespace-nowrap hidden md:flex"
            >
              {filteredSessions.every((session) =>
                selectedSessions.has(session.id),
              )
                ? "Deselect All"
                : "Select All"}
            </Button>
          )}
          <Button
            onClick={handleBulkDelete}
            variant="destructive"
            disabled={selectedSessions.size === 0}
            className="hidden md:flex whitespace-nowrap"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete ({selectedSessions.size})
          </Button>
          <Button
            onClick={handleCreateSession}
            disabled={createSession.isPending}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 text-white hidden md:flex whitespace-nowrap"
          >
            <Plus className="w-4 h-4 mr-1" />
            New Session
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="md:hidden"
              >
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {filteredSessions.length > 0 && (
                <DropdownMenuItem onClick={toggleSelectAll}>
                  {filteredSessions.every((session) =>
                    selectedSessions.has(session.id),
                  )
                    ? "Deselect All"
                    : "Select All"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem 
                onClick={handleBulkDelete}
                disabled={selectedSessions.size === 0}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete ({selectedSessions.size})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            onClick={handleCreateSession}
            disabled={createSession.isPending}
            size="icon"
            className="bg-blue-600 hover:bg-blue-700 text-white md:hidden h-9 w-9"
            title="New Session"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="flex flex-col gap-2">
          {(!sessions || sessions.length === 0) ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              No sessions yet. Create one to get started.
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              No sessions found
            </div>
          ) : (
            sessionTree.map((node) => renderSessionNode(node))
          )}
        </div>
      </div>

      <DeleteSessionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        isDeleting={deleteSession.isPending}
        sessionCount={
          Array.isArray(sessionToDelete) ? sessionToDelete.length : 1
        }
      />
    </div>
  );
};


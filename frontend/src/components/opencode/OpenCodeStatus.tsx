import { useSessionStatusMap } from "@/hooks/useOpenCode";
import { useBackendConnection } from "@/hooks/useOpencodeHealth";

export function OpenCodeStatus() {
  const { data: dbStatuses, isError: statusError, isFetching: statusFetching, failureCount: statusFails } = useSessionStatusMap();
  const { connected: isConnected, reconnecting: isReconnecting } = useBackendConnection({
    data: dbStatuses,
    isError: statusError,
    isFetching: statusFetching,
    failureCount: statusFails,
  });

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 h-8 px-2">
      <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${isConnected ? "bg-green-500" : isReconnecting ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`} />
      <span className="text-xs text-muted-foreground hidden sm:inline">{isConnected ? "Connected" : isReconnecting ? "Reconnecting..." : "Disconnected"}</span>
    </div>
  );
}
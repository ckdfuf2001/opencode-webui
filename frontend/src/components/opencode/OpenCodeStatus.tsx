import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

interface HealthResponse {
  status: string;
  database: string;
  opencode: string;
  opencodePort: number;
}

async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export function OpenCodeStatus() {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["opencode-health"],
    queryFn: getHealth,
    refetchInterval: 10000,
    retry: 3,
  });

  // Checking 은 최초 로드에만 표시한다. 백그라운드 재조회(isFetching) 중에는
  // 마지막 상태를 유지해 다른 레포 생성 중에도 배지가 계속 도는 것을 막는다.
  const loading = isLoading;
  const opencodeHealthy = data?.opencode === "healthy";

  return (
    <Badge
      variant="outline"
      className={`gap-1.5 px-2.5 py-1 text-xs font-medium border ${
        loading
          ? "border-border text-muted-foreground"
          : opencodeHealthy
            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
            : "bg-red-500/10 text-red-500 border-red-500/30"
      } ${isFetching && !loading ? "opacity-60" : ""}`}
      title={data ? `opencode port: ${data.opencodePort}` : "opencode status"}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <span
          className={`w-2 h-2 rounded-full ${
            opencodeHealthy ? "bg-emerald-500" : "bg-red-500"
          }`}
        />
      )}
      <span>
        {loading
          ? "Checking"
          : opencodeHealthy
            ? "Connected"
            : "Offline"}
      </span>
    </Badge>
  );
}
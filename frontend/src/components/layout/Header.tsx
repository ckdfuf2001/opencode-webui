import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { useTheme } from "@/hooks/useTheme";
import type { ReactNode } from "react";

interface HeaderProps {
  title: string;
  backTo?: string;
  action?: ReactNode;
}

export function Header({ title, backTo, action }: HeaderProps) {
  const { open: openSettings } = useSettingsDialog();
  const theme = useTheme();

  return (
    <header className="sticky top-0 z-10 bg-gradient-to-b from-background via-background to-background border-b border-border backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-4">
            {backTo && <BackButton to={backTo} />}
            <div className="flex items-center gap-2">
              {title === "OpenCode" ? (
                <img
                  src={theme === 'light' ? "/cyd-logo-navy.png" : "/cyd-logo-grey.png"}
                  alt="Create Your Desk"
                  className="h-9 w-auto sm:h-10"
                />
              ) : (
                <h1 className="text-xl font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent truncate">
                  {title}
                </h1>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {action && <div>{action}</div>}
            <Button
              variant="ghost"
              size="icon"
              onClick={openSettings}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
      <div className="border-t border-border/60 bg-muted/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="py-0.5 text-center text-[11px] text-muted-foreground">
            Trial version — this release is unlimited for personal Desk use.
          </p>
        </div>
      </div>
    </header>
  );
}

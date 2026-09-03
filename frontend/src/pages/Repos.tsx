import { useState } from "react";
import { RepoList } from "@/components/repo/RepoList";
import { AddRepoDialog } from "@/components/repo/AddRepoDialog";
import { FileBrowserSheet } from "@/components/file-browser/FileBrowserSheet";
import { Header } from "@/components/layout/Header";
import { OpenCodeStatus } from "@/components/opencode/OpenCodeStatus";
import { CommandsPanel } from "@/components/command/CommandsPanel";
import { NavigationTree } from "@/components/navigation/NavigationTree";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FolderOpen, Briefcase, Settings, Menu } from "lucide-react";
import { OPENCODE_API_ENDPOINT } from "@/config";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
export function Repos() {
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { open: openSettings } = useSettingsDialog();

  const handleCloseFileBrowser = () => {
    setFileBrowserOpen(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-background">
      <Header
        title="OpenCode"
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setNavOpen(true)} className="h-8 w-8" title="메뉴">
              <Menu className="w-4 h-4" />
            </Button>
            <OpenCodeStatus />
            <div className="inline-flex items-center rounded-md border border-border overflow-hidden">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setFileBrowserOpen(true)}
                className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border"
                title="Workspace"
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCommandsOpen(true)}
                className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none border-r border-border"
                title="Commands"
              >
                <Briefcase className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={openSettings}
                className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8 rounded-none"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
            </div>
          </div>
        }
      />
      <div className="container mx-auto sm:p-2 p-4">
        <RepoList onAddRepo={() => setAddRepoOpen(true)} />
      </div>
      <AddRepoDialog open={addRepoOpen} onOpenChange={setAddRepoOpen} />
      <CommandsPanel
        open={commandsOpen}
        onClose={() => setCommandsOpen(false)}
        opcodeUrl={OPENCODE_API_ENDPOINT}
        sessionID=""
      />
      <FileBrowserSheet
        isOpen={fileBrowserOpen}
        onClose={handleCloseFileBrowser}
        basePath=""
        repoName="Workspace Root"
      />
      <Dialog open={navOpen} onOpenChange={setNavOpen}>
        <DialogContent className="max-w-sm max-h-[80vh] overflow-y-auto">
          <DialogTitle>네비게이션</DialogTitle>
          <NavigationTree onNavigate={() => setNavOpen(false)} onNewRepo={() => { setNavOpen(false); setAddRepoOpen(true) }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

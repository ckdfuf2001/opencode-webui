import { useState } from "react";
import { RepoList } from "@/components/repo/RepoList";
import { AddRepoDialog } from "@/components/repo/AddRepoDialog";
import { FileBrowserSheet } from "@/components/file-browser/FileBrowserSheet";
import { Header } from "@/components/layout/Header";
import { OpenCodeStatus } from "@/components/opencode/OpenCodeStatus";
import { CommandsPanel } from "@/components/command/CommandsPanel";
import { Button } from "@/components/ui/button";
import { Plus, FolderOpen, Terminal } from "lucide-react";
import { OPENCODE_API_ENDPOINT } from "@/config";

export function Repos() {
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);

  const handleCloseFileBrowser = () => {
    setFileBrowserOpen(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-background">
      <Header
        title="OpenCode"
        action={
          <div className="flex items-center gap-2">
            <OpenCodeStatus />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setFileBrowserOpen(true)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
              title="Workspace"
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCommandsOpen(true)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 h-8 w-8"
              title="Commands"
            >
              <Terminal className="w-4 h-4" />
            </Button>
            <Button
              onClick={() => setAddRepoOpen(true)}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white transition-all duration-200 hover:scale-105"
            >
              <Plus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Repository</span>
            </Button>
          </div>
        }
      />
      <div className="container mx-auto sm:p-2 p-4">
        <RepoList />
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
    </div>
  );
}

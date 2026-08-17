import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScheduleManager } from '@/components/schedule/ScheduleManager'

interface ScheduleSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: number
  opcodeUrl: string
  directory?: string
  initialDate?: Date | null
}

export function ScheduleSettingsDialog({ open, onOpenChange, repoId, opcodeUrl, directory, initialDate }: ScheduleSettingsDialogProps) {
  const navigate = useNavigate()
  const [mountKey, setMountKey] = useState(0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setMountKey((k) => k + 1)
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-full max-w-none rounded-none h-[100dvh] sm:w-[90%] sm:max-w-xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto p-3 sm:p-6">
        <DialogHeader className="flex-row items-center justify-start gap-2 sm:text-left">
          <DialogTitle>Project Schedules</DialogTitle>
        </DialogHeader>
        <ScheduleManager
          key={mountKey}
          repoId={repoId}
          opcodeUrl={opcodeUrl}
          directory={directory}
          initialDate={initialDate}
          active={open}
          onNavigate={(path) => navigate(path)}
        />
      </DialogContent>
    </Dialog>
  )
}
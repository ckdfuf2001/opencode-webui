import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertTriangle } from 'lucide-react'

interface DeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (withIndex?: boolean) => void
  onCancel: () => void
  title: string
  description: string
  itemName?: string
  isDeleting?: boolean
  withIndexOption?: boolean
}

export function DeleteDialog({ 
  open, 
  onOpenChange, 
  onConfirm, 
  onCancel, 
  title, 
  description, 
  itemName,
  isDeleting = false,
  withIndexOption = false,
}: DeleteDialogProps) {
  const [withIndex, setWithIndex] = useState(true)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[90%] sm:max-w-sm '>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>
        
        {itemName && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will permanently delete "{itemName}". This action cannot be undone.
            </AlertDescription>
          </Alert>
        )}

        {withIndexOption && (
          <label className="flex items-center gap-2 text-sm py-2">
            <input type="checkbox" checked={withIndex} onChange={(e) => setWithIndex(e.target.checked)} className="rounded" />
            Also delete search index
          </label>
        )}
        
        <DialogFooter className='gap-2'>
          <Button variant="outline" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button 
            variant="destructive" 
            onClick={() => onConfirm(withIndexOption ? withIndex : undefined)} 
            disabled={isDeleting}
            className="bg-red-600 hover:bg-red-700 text-white font-semibold border-red-600"
          >
            {isDeleting && 'Deleting...'}
            {!isDeleting && (title.includes('Configuration') ? 'Delete Configuration' : withIndexOption && withIndex ? 'Delete with index' : 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

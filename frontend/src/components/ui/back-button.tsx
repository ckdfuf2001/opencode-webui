import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BackButtonProps {
  to?: string;
  className?: string;
  onClick?: () => void;
}

export function BackButton({ to = "/", className = "", onClick }: BackButtonProps) {
  if (onClick) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={onClick}
        className={`h-8 w-8 shrink-0 ${className}`}
        title="메뉴"
      >
        <Menu className="w-4 h-4" />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-8 w-8 shrink-0 ${className}`}
      title="메뉴"
      asChild
    >
      <a href={to} className="flex items-center justify-center">
        <Menu className="w-4 h-4" />
      </a>
    </Button>
  );
}
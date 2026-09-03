import { Menu } from "lucide-react";

interface BackButtonProps {
  to?: string;
  className?: string;
  onClick?: () => void;
}

export function BackButton({ to = "/", className = "", onClick }: BackButtonProps) {
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`text-zinc-400 hover:text-zinc-100 transition-all duration-200 hover:scale-105 border border-zinc-700 rounded-md px-2 py-1 ${className}`}
        title="메뉴"
      >
        <Menu className="w-4 h-4" />
      </button>
    );
  }
  return (
    <a
      href={to}
      className={`text-zinc-400 hover:text-zinc-100 transition-all duration-200 hover:scale-105 border border-zinc-700 rounded-md px-2 py-1 flex items-center justify-center ${className}`}
      title="메뉴"
    >
      <Menu className="w-4 h-4" />
    </a>
  );
}
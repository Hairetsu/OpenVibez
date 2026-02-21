import { cn } from '@/lib/utils';

type TitleBarProps = {
  children?: React.ReactNode;
  className?: string;
};

export const TitleBar = ({ children, className }: TitleBarProps) => {
  return (
    <header
      className={cn(
        'title-bar flex h-11 shrink-0 items-center border-b border-border/50 bg-background/60 backdrop-blur-xl',
        'pl-[78px] pr-3',
        className
      )}
    >
      {children}
    </header>
  );
};

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

export const MarkdownText = ({
  content,
  className,
}: {
  content: string;
  className?: string;
}) => (
  <div className={cn("markdown-text", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => (
          <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200"
          >
            {children}
          </a>
        ),
        code: ({ className: codeClassName, children }) => {
          const raw = String(children);
          const isBlock = raw.includes("\n");
          if (!isBlock) {
            return (
              <code
                className={cn(
                  "rounded border border-border/40 bg-black/20 px-1 py-0.5 font-mono text-[11px] text-emerald-200/90",
                  codeClassName,
                )}
              >
                {children}
              </code>
            );
          }

          return (
            <code
              className={cn(
                "block font-mono text-[11px] leading-relaxed",
                codeClassName,
              )}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-lg border border-border/30 bg-black/35 px-3 py-2">
            {children}
          </pre>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

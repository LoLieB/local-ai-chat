import * as React from "react";

function inline(text: string) {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gi);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) return <code key={index}>{token.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(token)) return <strong key={index}>{token.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i.exec(token);
    return link ? <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a> : token;
  });
}

export function MessageBody({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  const fence = /^\s*```/;
  const item = /^\s*([-*]|\d+\.)\s+(.+)/;
  while (i < lines.length) {
    const start = i;
    if (!lines[i].trim()) { i++; continue; }
    if (fence.test(lines[i])) {
      i++;
      const body = i;
      while (i < lines.length && !fence.test(lines[i])) i++;
      blocks.push(<pre key={start}><code>{lines.slice(body, i).join("\n")}</code></pre>);
      i++;
    } else if (item.test(lines[i])) {
      const ordered = /^\s*\d/.test(lines[i]);
      const List = ordered ? "ol" : "ul";
      const children: React.ReactNode[] = [];
      while (i < lines.length) {
        const match = item.exec(lines[i]);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        children.push(<li key={i++}>{inline(match[2])}</li>);
      }
      blocks.push(<List key={start}>{children}</List>);
    } else {
      i++;
      while (i < lines.length && lines[i].trim() && !item.test(lines[i]) && !fence.test(lines[i])) i++;
      blocks.push(<p key={start}>{lines.slice(start,i).map((line, j) => <React.Fragment key={j}>{j > 0 && <br/>}{inline(line)}</React.Fragment>)}</p>);
    }
  }
  return <div className="studio-message-body">{blocks}</div>;
}

import { useEffect, useState } from "react";
import {ThumbsUp, X, BusFront, Loader2, Search } from "lucide-react";


async function addUrl(q: string): Promise<String> { //<SimilarIssue[]
  return ""
}

export function NewUrlDialog() {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [searching, setSearching] = useState(false); //toRemove
  const [downloadJD, setdownloadJD] = useState(false);

  const openReport = async () => {
    //const d = await collect();
    //setDiag(d);
    setOpen(true);
    // One exact-match search by fingerprint: same bug already filed → the
    // strongest dedupe signal, shown before the user types a word.
    
    //todo** use 'addUrl' above
    //searchIssues(`in:body "${fingerprint(d)}"`).then((found) => {
    //  if (found.length) setSimilar(found);
    //});
  };

  const seeend = async () => {
    sendUrl().then((r) => {
      console.log("Yeeeyuh sendUrl", r);
      setOpen(false)
    })
  }
  

  const checkExisting = async () => {
    const words = desc.trim().split(/\s+/).slice(0, 6).join(" ");
    if (!words) return;
    //todo >> send url
    console.log("checkExisting", words)
    setSearching(true);
    //const found = await searchIssues(`label:web-alpha ${words}`);
    //setSearching(false);
    //if (found.length) setSimilar(found);
  };

  const sendUrl = async () => { //url:string
    try {
      const res = await fetch("/api/home/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: desc, title: title, company:company, download: downloadJD }),
      });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}));
        //finish("error", e.error || "Failed to start");
        return;
      }
      return res.statusText;
    }catch {
      console.log("sendUrl...error?", desc)
    }
  }

  return (
    <>
      <div className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
        <button onClick={openReport} className="ml-1 inline-flex items-center justify-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-brand-text transition-colors hover:bg-brand/15 max-sm:min-h-[44px]">
          <ThumbsUp className="size-3" /> Add URL
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Report a bug" onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-border bg-[var(--bg)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <BusFront className="size-4 text-brand" />
              <h2 className="text-sm font-semibold text-foreground">Report aaa bug · sfsdf</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="ml-auto text-faint transition-colors hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
            <div>
              <textarea
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
                placeholder="What is da Title?"
                className="w-full resize-none rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition focus:border-brand/50 focus:ring-2 focus:ring-brand/20"
              />               
            </div>
            <textarea
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoFocus
              placeholder="What is da Company?"
              className="w-full resize-none rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition focus:border-brand/50 focus:ring-2 focus:ring-brand/20"
            />
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              autoFocus
              placeholder="What is da new url?"
              className="w-full resize-none rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition focus:border-brand/50 focus:ring-2 focus:ring-brand/20"
            />
            {desc.trim().split(/\s+/).length >= 3 && (
              <button
                onClick={checkExisting}
                disabled={searching}
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-brand disabled:opacity-60"
              >
                {searching ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />} Check for existing reports first
              </button>
            )}

            {/* multi-select — power-user batch to shortlist */}
              <input
                type="checkbox"
                checked={downloadJD}
                onChange={(e) => setdownloadJD(!downloadJD)}
                aria-label={`Download job JD`}
                className="size-4 shrink-0 accent-brand max-sm:min-h-[44px] max-sm:min-w-[24px]"
              />
            
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => seeend()} className="rounded-full px-4 py-2 text-sm text-muted transition-colors hover:text-foreground">
                Sennnnd?
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

}
/*${job.company} ${job.role}
className="fixed bottom-3 left-3 z-[70] flex items-center gap-2 rounded-full border border-brand/30 bg-surface/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur-md"
              <a
                href={sendUrl(desc)}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                <Bug className="size-4" /> Open GitHub issue
              </a>
*/
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { RGA, merge } from "./rga";
import { socket, type CrdtOp, type CursorOp, type SyncMessage } from "./ws";
import "./App.css";

interface Run {
    text: string;
    bold: boolean;
    italic: boolean;
}

// Naive prefix/suffix diff: handles insert, delete, and "select + retype"
// (delete+insert combined) uniformly, since it just looks at what actually
// changed between the two strings rather than guessing from length alone.
function diff(oldText: string, newText: string) {
    const maxStart = Math.min(oldText.length, newText.length);
    let start = 0;
    while (start < maxStart && oldText[start] === newText[start]) start++;

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        oldText[oldEnd - 1] === newText[newEnd - 1]
    ) {
        oldEnd--;
        newEnd--;
    }

    return {
        start,
        deleteCount: oldEnd - start,
        inserted: newText.slice(start, newEnd),
    };
}

// Offline queue: persists ops to localStorage so they survive refresh
const QUEUE_KEY = "heva:offline-queue";

function loadQueue(): CrdtOp[] {
    try {
        return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveQueue(queue: CrdtOp[]) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function App() {
    const rgaRef = useRef<RGA | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [text, setText] = useState("");
    const [runs, setRuns] = useState<Run[]>([]);
    const [status, setStatus] = useState("connecting...");
    const [replicas, setReplicas] = useState<string[]>([]);
    const offlineQueueRef = useRef<CrdtOp[]>(loadQueue());

    // Cursor tracking
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const cursorMapRef = useRef<Map<string, { el: HTMLDivElement; label: HTMLDivElement; pos: number }>>(new Map());
    const measureCanvasRef = useRef(document.createElement("canvas"));
    const lastBroadcastRef = useRef(0);

    function getCursorXY(text: string, pos: number): { x: number; y: number } {
        const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
        const charW = (() => {
            const ctx = measureCanvasRef.current.getContext("2d")!;
            ctx.font = `16px ${mono}`;
            return ctx.measureText("M").width;
        })();
        const lineH = 16 * 1.45;
        const before = text.slice(0, pos);
        const lines = before.split("\n");
        const line = lines.length - 1;
        const col = lines[line].length;
        return { x: col * charW, y: line * lineH };
    }

    function broadcastCursor(pos: number) {
        const now = Date.now();
        if (now - lastBroadcastRef.current < 50) return;
        lastBroadcastRef.current = now;
        const color = stringToColor(socket.id || "");
        socket.emit("cursor-op", { type: "cursor", position: pos, color } satisfies CursorOp);
    }

    function stringToColor(str: string): string {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
        return `hsl(${h % 360}, 70%, 50%)`;
    }

    function updateRemoteCursor(id: string, pos: number, color: string) {
        const overlay = overlayRef.current;
        if (!overlay) return;

        let entry = cursorMapRef.current.get(id);
        if (!entry) {
            const el = document.createElement("div");
            el.className = "cursor-caret";
            el.style.background = color;
            const label = document.createElement("div");
            label.className = "cursor-label";
            label.style.background = color;
            label.textContent = id.slice(0, 4);
            overlay.appendChild(el);
            overlay.appendChild(label);
            entry = { el, label, pos };
            cursorMapRef.current.set(id, entry);
        }

        const { x, y } = getCursorXY(rgaRef.current?.toString() ?? text, pos);
        entry.el.style.left = `${x}px`;
        entry.el.style.top = `${y}px`;
        entry.label.style.left = `${x}px`;
        entry.label.style.top = `${y}px`;
        entry.pos = pos;
    }

    function removeRemoteCursor(id: string) {
        const entry = cursorMapRef.current.get(id);
        if (entry) {
            entry.el.remove();
            entry.label.remove();
            cursorMapRef.current.delete(id);
        }
    }

    // Update cursor positions when text changes
    useEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        for (const [id, entry] of cursorMapRef.current) {
            const { x, y } = getCursorXY(text, entry.pos);
            entry.el.style.left = `${x}px`;
            entry.el.style.top = `${y}px`;
            entry.label.style.left = `${x}px`;
            entry.label.style.top = `${y}px`;
        }
    }, [text]);

    // Pulls the latest text + formatted runs out of the RGA. Called after
    // every local or remote mutation (including mark toggles, which don't
    // change the text itself but do change what the preview should show).
    const syncFromRga = useCallback(() => {
        const rga = rgaRef.current;
        if (!rga) return;
        setText(rga.toString());
        setRuns(rga.getRuns());
    }, []);

    useEffect(() => {
        const onSync = (msg: SyncMessage) => {
            const prevRga = rgaRef.current;
            const serverNodes = msg.nodes;

            if (prevRga) {
                // Reconnection: merge local offline state with server state
                const localNodes = prevRga.serialize();
                const merged = merge(localNodes, serverNodes);
                rgaRef.current = merged;
            } else {
                // First connect: just load server state
                const rga = new RGA(msg.replica);
                rga.loadState(serverNodes);
                rgaRef.current = rga;
            }

            syncFromRga();
            setStatus(`connected as ${msg.replica}`);
            setReplicas(msg.replicas);

            // Flush queued offline ops after merge is complete
            const queue = offlineQueueRef.current;
            if (queue.length > 0) {
                console.log(`Flushing ${queue.length} queued offline ops`);
                for (const op of queue) {
                    socket.emit("crdt-op", op);
                }
                offlineQueueRef.current = [];
                saveQueue([]);
            }
        };

        const onOp = (op: CrdtOp) => {
            const rga = rgaRef.current;
            if (!rga) return;

            if (op.type === "insert") {
                rga.remoteInsert(op.id, op.character, op.parentId);
            } else if (op.type === "delete") {
                rga.remoteDelete(op.id);
            } else if (op.type === "mark") {
                rga.remoteSetMark(op.targetId, op.mark, op.value, op.opId);
            }

            syncFromRga();
        };

        const onCursorOp = (op: CursorOp & { id: string }) => {
            updateRemoteCursor(op.id, op.position, op.color);
        };

        const onNewReplica = (id: string) => {
            setReplicas((prev) => (prev.includes(id) ? prev : [...prev, id]));
        };

        const onReplicaLeft = (id: string) => {
            setReplicas((prev) => prev.filter((r) => r !== id));
            removeRemoteCursor(id);
        };

        const onDisconnect = () => {
            setStatus("disconnected");
            // Clear all remote cursors on disconnect
            for (const [id] of cursorMapRef.current) removeRemoteCursor(id);
        };

        socket.on("sync", onSync);
        socket.on("crdt-op", onOp);
        socket.on("cursor-op", onCursorOp);
        socket.on("new-replica", onNewReplica);
        socket.on("replica-left", onReplicaLeft);
        socket.on("disconnect", onDisconnect);

        return () => {
            socket.off("sync", onSync);
            socket.off("crdt-op", onOp);
            socket.off("cursor-op", onCursorOp);
            socket.off("new-replica", onNewReplica);
            socket.off("replica-left", onReplicaLeft);
            socket.off("disconnect", onDisconnect);
        };
    }, [syncFromRga]);

    const emitOp = useCallback((op: CrdtOp) => {
        if (socket.connected) {
            socket.emit("crdt-op", op);
        } else {
            offlineQueueRef.current.push(op);
            saveQueue(offlineQueueRef.current);
        }
    }, []);

    const handleChange = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => {
            const rga = rgaRef.current;
            if (!rga) return;

            const newText = event.target.value;
            const { start, deleteCount, inserted } = diff(text, newText);

            for (let i = 0; i < deleteCount; i++) {
                const id = rga.localDelete(start);
                if (id) emitOp({ type: "delete", id });
            }

            for (let i = 0; i < inserted.length; i++) {
                const node = rga.localInsert(start + i, inserted[i]);
                emitOp({
                    type: "insert",
                    id: node.id,
                    character: node.character,
                    parentId: node.parent!,
                });
            }

            syncFromRga();
        },
        [text, syncFromRga, emitOp],
    );

    const toggleMark = useCallback(
        (mark: "bold" | "italic") => {
            const rga = rgaRef.current;
            const textarea = textareaRef.current;
            if (!rga || !textarea) return;

            const { selectionStart, selectionEnd } = textarea;
            if (selectionStart == null || selectionEnd == null || selectionStart === selectionEnd) return;

            const nextValue = !rga.isMarkActive(selectionStart, selectionEnd, mark);
            const ops = rga.localSetMark(selectionStart, selectionEnd, mark, nextValue);
            for (const op of ops) {
                emitOp({
                    type: "mark",
                    targetId: op.targetId,
                    mark,
                    value: nextValue,
                    opId: op.opId,
                });
            }

            syncFromRga();
        },
        [syncFromRga, emitOp],
    );

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            if (event.key === "b") {
                event.preventDefault();
                toggleMark("bold");
            } else if (event.key === "i") {
                event.preventDefault();
                toggleMark("italic");
            }
        },
        [toggleMark],
    );

    const handleCursorMove = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        broadcastCursor(ta.selectionStart ?? 0);
    }, []);

    return (
        <div id="editor">
            <header>
                <h1>Collaborative Editor</h1>
                <span className="status">{status}</span>
                <span>{replicas.length}</span>
            </header>
            <div className="toolbar">
                <button type="button" onMouseDown={(e) => { e.preventDefault(); toggleMark("bold"); }}>
                    <strong>B</strong>
                </button>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); toggleMark("italic"); }}>
                    <em>I</em>
                </button>
            </div>
            <div className="textarea-wrap">
                <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    onMouseUp={handleCursorMove}
                    onKeyUp={handleCursorMove}
                    onSelect={handleCursorMove}
                    placeholder="Start typing..."
                    spellCheck={false}
                    disabled={!rgaRef.current}
                />
                <div ref={overlayRef} className="cursor-overlay" />
            </div>
            <div className="preview">
                {runs.map((run, i) => {
                    let content: ReactNode = run.text || "\u00A0";
                    if (run.italic) content = <em key={`i-${i}`}>{content}</em>;
                    if (run.bold) content = <strong key={`b-${i}`}>{content}</strong>;
                    return <span key={i}>{content}</span>;
                })}
            </div>
        </div>
    );
}

export default App;

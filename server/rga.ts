export interface ID {
    replica: string;
    seq: number;
}

export type MarkType = "bold" | "italic" | "heading" | "code";

export interface MarkValue {
    id: ID;
    value: boolean;
}

export interface SerializedNode {
    id: ID;
    character: string;
    parent: ID;
    tombstone: boolean;
    marks: Partial<Record<MarkType, MarkValue>>;
}

class IDGenerator {
    private counter = 0;

    constructor(private replica: string) { }

    next(): ID {
        return {
            replica: this.replica,
            seq: ++this.counter,
        };
    }

    update(remoteSeq: number) {
        this.counter = Math.max(this.counter, remoteSeq);
    }
}

class Node {
    marks: Partial<Record<MarkType, MarkValue>> = {};

    constructor(
        public id: ID,
        public character: string,
        public parent: ID | null,
        public tombstone: boolean = false
    ) { }
}
// tombstone is alos propagated through network then why

export class RGA {
    private nodes: Node[];
    private idGenerator: IDGenerator;

    constructor(replica: string) {
        this.nodes = [];
        this.idGenerator = new IDGenerator(replica);

        const head = new Node(
            { replica: "HEAD", seq: 0 },
            "",
            null
        );

        this.nodes.push(head);
    }

    private compareIds(id1: ID, id2: ID): boolean {
        if (id1.seq !== id2.seq) return id1.seq > id2.seq;
        return id1.replica > id2.replica;
    }

    // private key(id: ID): string {
    //     return `${id.replica}:${id.seq}`;
    // }

    private getLinerNodes() {
        return this.nodes.slice(1);
    }

    private head(): Node {
        return this.nodes[0]!; // always present, pushed in the constructor
    }

    private findById(id: ID): Node | undefined {
        return this.nodes.find(n => n.id.replica === id.replica && n.id.seq === id.seq);
    }

    private findVisibleNode(index: number): Node {
        const linear = this.getLinerNodes();
        let visibleCount = 0;

        for (const node of linear) {
            if (!node.tombstone) {
                if (visibleCount === index) {
                    return node;
                }
                visibleCount++;
            }
        }
        return this.head(); // Fallback to HEAD
    }

    createNode(character: string, parent: ID): Node {
        const node = new Node(
            this.idGenerator.next(),
            character,
            parent
        );

        this.nodes.push(node);

        return node;
    }

    localInsert(index: number, character: string): Node {
        const parentNode = index > 0 ? this.findVisibleNode(index - 1) : this.head();
        const nextId = this.idGenerator.next();
        return this.remoteInsert(nextId, character, parentNode.id);
    }

    // Returns the id of the tombstoned node so it can be broadcast to other
    // replicas (they need the id, not the now-meaningless local index).
    localDelete(index: number): ID | null {
        const targetNode = this.findVisibleNode(index);
        if (targetNode.id.replica === "HEAD") return null; // nothing to delete
        targetNode.tombstone = true;
        return targetNode.id;
    }

    // Applies a delete coming from another replica. Idempotent: tombstoning
    // an already-tombstoned (or unknown) node is a no-op.
    remoteDelete(id: ID): void {
        const node = this.findById(id);
        if (node && !node.tombstone) node.tombstone = true;
    }

    // Toggles a mark across a visible range. Returns one {targetId, opId}
    // pair per character so the caller can broadcast each as its own op,
    // consistent with how insert/delete work.
    localSetMark(start: number, end: number, mark: MarkType, value: boolean): { targetId: ID; opId: ID }[] {
        const ops: { targetId: ID; opId: ID }[] = [];
        for (let i = start; i < end; i++) {
            const node = this.findVisibleNode(i);
            if (node.id.replica === "HEAD") continue;
            const opId = this.idGenerator.next();
            this.remoteSetMark(node.id, mark, value, opId);
            ops.push({ targetId: node.id, opId });
        }
        return ops;
    }

    // Last-writer-wins per (node, mark): whichever op has the "greater" id
    // (same total order used for sibling ordering) wins, so concurrent
    // conflicting toggles on the same character converge everywhere
    // instead of crashing or silently favoring whoever arrived first.
    remoteSetMark(targetId: ID, mark: MarkType, value: boolean, opId: ID): void {
        const node = this.findById(targetId);
        if (!node) return;

        this.idGenerator.update(opId.seq);

        // why ?????
        //
        const current = node.marks[mark];
        if (!current || this.compareIds(opId, current.id)) {
            node.marks[mark] = { id: opId, value };
        }
    }

    isMarkActive(start: number, end: number, mark: MarkType): boolean {
        if (start >= end) return false;
        for (let i = start; i < end; i++) {
            if (!this.findVisibleNode(i).marks[mark]?.value) return false;
        }
        return true;
    }

    remoteInsert(id: ID, character: string, parentID: ID) {
        // check idempotent
        const dupNode = this.findById(id);
        if (dupNode) return dupNode

        this.idGenerator.update(id.seq)

        // find place to insert , but before that create a node
        const node = new Node(id, character, parentID);
        const parentIdx = this.nodes.findIndex(n => n.id.replica === parentID.replica && n.id.seq === parentID.seq);
        if (parentIdx == -1) return node;

        const isChildOf = (a: ID | null, b: ID): boolean => !!a && a.replica === b.replica && a.seq === b.seq;

        let insertIdx = parentIdx + 1;
        while (insertIdx < this.nodes.length) {
            const neighbor = this.nodes[insertIdx];

            if (!neighbor) break;

            // Walk up from `neighbor` to whichever ancestor is a *direct*
            // child of parentID (a true sibling of the node being
            // inserted). Without this, a neighbor that is actually a
            // grandchild of a sibling would get compared as if it were a
            // sibling itself, which breaks a whole subtree out of order and
            // makes insertion order-dependent (not commutative).
            let sibling = neighbor;
            while (!isChildOf(sibling.parent, parentID)) {
                const next = sibling.parent ? this.findById(sibling.parent) : undefined;
                if (!next) break;
                sibling = next;
            }

            if (!isChildOf(sibling.parent, parentID)) {
                break; // left parentID's subtree entirely
            }

            if (this.compareIds(node.id, sibling.id)) {
                break; // new node wins, insert before this sibling's whole subtree
            }

            insertIdx++; // sibling wins, keep skipping past its subtree
        }

        this.nodes.splice(insertIdx, 0, node);
        return node;



    }

    public toString(): string {
        return this.getLinerNodes()
            .filter(n => !n.tombstone)
            .map(n => n.character)
            .join("");
    }

    // Groups visible characters into runs of contiguous, identically-marked
    // text, which is what a rich-text UI layer actually wants to render.
    getRuns(): { text: string; bold: boolean; italic: boolean; heading: boolean; code: boolean }[] {
        const runs: { text: string; bold: boolean; italic: boolean; heading: boolean; code: boolean }[] = [];

        for (const node of this.getLinerNodes()) {
            if (node.tombstone) continue;
            const bold = node.marks.bold?.value ?? false;
            const italic = node.marks.italic?.value ?? false;
            const heading = node.marks.heading?.value ?? false;
            const code = node.marks.code?.value ?? false;

            const last = runs[runs.length - 1];
            if (last && last.bold === bold && last.italic === italic && last.heading === heading && last.code === code) {
                last.text += node.character;
            } else {
                runs.push({ text: node.character, bold, italic, heading, code });
            }
        }

        if (runs.length === 0) runs.push({ text: "", bold: false, italic: false, heading: false, code: false });
        return runs;
    }

    // Full document state, used to bring a newly-connected replica up to
    // date. Nodes are naturally emitted parent-before-child (a node can only
    // ever be spliced in after its parent already exists), so replaying this
    // list with remoteInsert/remoteDelete on another replica reconstructs
    // the same structure.
    serialize(): SerializedNode[] {
        return this.getLinerNodes().map(n => ({
            id: n.id,
            character: n.character,
            parent: n.parent as ID,
            tombstone: n.tombstone,
            marks: n.marks,
        }));
    }

    loadState(nodes: SerializedNode[]): void {
        for (const n of nodes) {
            this.remoteInsert(n.id, n.character, n.parent);
            if (n.tombstone) this.remoteDelete(n.id);
            for (const mark of Object.keys(n.marks) as MarkType[]) {
                const markValue = n.marks[mark]!;
                this.remoteSetMark(n.id, mark, markValue.value, markValue.id);
            }
        }
    }

}

// Takes two independently-evolved (diverged) document states and produces
// a single replica containing the union of both. Built entirely out of the
// same idempotent, order-independent remoteInsert/remoteDelete/remoteSetMark
// primitives used for live sync, so this is:
//   - commutative:   merge(a, b).toString() === merge(b, a).toString()
//   - associative:    merge(merge(a, b), c) === merge(a, merge(b, c))
//   - idempotent:     merge(a, a) === a
// (see rga.test.ts for the proofs).
export function merge(a: SerializedNode[], b: SerializedNode[]): RGA {
    const merged = new RGA("merge");
    merged.loadState(a);
    merged.loadState(b);
    return merged;
}

This project contains a really basic implementation of CRDT(conflict-free data type) using RGA (Replicted-Growable Array). 

Project is divided into 2 main folders 
 - `client`: it contains react code using `vite` and all the logic related to ui
 - `server`: here is our wwbsocket server. 

in both the folders there is one common file name `rga.ts`. 
it is the core engine of handling all the operations performed by the user on the editor ui. i'll walk you through this file very soon. 


to run the project locally 
- clone the repo
- `cd client && bun i && bun dev`
- in a new terminal `cd server && bun i && bun index.ts`

now open the browser `http://localhost:5173` and test it. 

rga.ts 
this file contains the core logic of CRDT where all the insertion, deletion and merge logic rest. 

let's understand it step-by-step

these are some basic type definitions used in our engine. 
```ts
export interface ID {
    replica: string;
    seq: number;
}

export type MarkType = "bold" | "italic";

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
```
<br/>
next section is the `IDGenrator` class, that generates the id for each of the node (in very simple -> charcter typed by the user). 
`next`: generates the next id
`update`: update the current id with the remote id in order to sync them, this function is necessary beacuse lets say 
user a is online and idle -> the counter is still at 0
user b types -> 100 words -> the counter is at 100
user a types now -> counter must update from 0 -> x

<br/>
now engine is confused who typed first, whose update top keep and whose not 
it will think user a typed first and hence break all the order. 
why we compare with id? -> answer very soon

```ts
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
```
<br/>

a node class, in very simple terms any character typed by the user is assigned with unique and id and is stored as a node.
marks here is for the formatting (bold, italic etc...)
```ts
class Node {
    marks: Partial<Record<MarkType, MarkValue>> = {};

    constructor(
        public id: ID,
        public character: string,
        public parent: ID | null,
        public tombstone: boolean = false
    ) { }
}

```

<br/>
now the next class is `RGA` class that is the main class consisting all the functions related to insertiona and deletion. let's see the important ones

basic initialisation
to keep things simple, we're storing nodes in array.

```ts
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
```

<br />

here we compare the id's. this also answers why are we even comparing with id
lets say 

```
orignal doc -> abc

at a same time
user a types -> a -> the doc must be -> abca
user b types -> d -> the doc must be -> abcd
merging them gets me either abcad or abcda
```
which is the correct state? you may also say why not "last write wins" -> the answer is what if they typed at the exact second

anyhow the comaprison we've done is very basic 
therefore we compare the id's of both the user, to determin the relative order of the texts.
```
user a -> id1 {replica: 'A', seq: 1}
user b -> id2 {replica: 'B', seq: 2}
compareIds(id1, id2) 
```
this produce the deterministic relative ordering and hence all the replicas/client ultimately reach the same state

```ts
    private compareIds(id1: ID, id2: ID): boolean {
        if (id1.seq !== id2.seq) return id1.seq > id2.seq;
        return id1.replica > id2.replica;
    }
```

<br/>

this function runs when inserting the local changes, this ultimately use the `remoteInsert` thst is used to insret the incoming change / node
```ts
    localInsert(index: number, character: string): Node {
        const parentNode = index > 0 ? this.findVisibleNode(index - 1) : this.head();
        const nextId = this.idGenerator.next();
        return this.remoteInsert(nextId, character, parentNode.id);
    }
```

<br/>

similarly another function, this deletes the nodes. 
we never remove them from list, insetad mark them as tombstone and ignore them when rendering
```ts
  localDelete(index: number): ID | null {
        const targetNode = this.findVisibleNode(index);
        if (targetNode.id.replica === "HEAD") return null; // nothing to delete
        targetNode.tombstone = true;
        return targetNode.id;
    }
```


<br/>

this runs when we get signal that someone deleted the node, it first finds the node by id and then mark it true if not yet done

this function is idempotent
```ts
 remoteDelete(id: ID): void {
        const node = this.findById(id);
        if (node && !node.tombstone) node.tombstone = true;
    }
```

<br />

these functions helps to propagate the formatting onto the text such as bold, italic, headings etc.

`localSetMark`: it gets the range of the text, the martype and the value itself.
then generates id for each step and set the mark using `remoteSetMark`.

`remoteSetMark`: here we ghet the node and before appklying any formatting, we again compare by id. and it never crashes on conflicting formattings

```
orignal doc -> hello
user a -> make h -> bold
user b -> make h -> italic
```
as we each operation has it's own unique id, it again comapares and whoever wins, wins the state

if user a then h is bold else h i italic


```ts
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
```

<br/>

now this is out most important function. 

```ts
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

```

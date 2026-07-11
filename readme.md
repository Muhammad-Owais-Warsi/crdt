## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Running Locally](#running-locally)
- [rga.ts - The Core Engine](#rgats---the-core-engine)
  - [Type Definitions](#type-definitions)
  - [IDGenerator](#idgenerator)
  - [Node Class](#node-class)
  - [RGA Class](#rga-class)
    - [Initialization](#initialization)
    - [compareIds](#compareids)
    - [localInsert](#localinsert)
    - [localDelete and remoteDelete](#localdelete-and-remotedelete)
    - [Formatting (localSetMark / remoteSetMark)](#formatting-localsitmark--remotesetmark)
    - [remoteInsert](#remoteinsert)
- [CRDT Properties](#crdt-properties)
  - [Commutativity](#commutativity)
  - [Associativity](#associativity)
  - [Idempotency](#idempotency)
- [Tests](#tests)

---

## Overview

This project contains a really basic implementation of CRDT(conflict-free data type) using RGA (Replicted-Growable Array). 

## Project Structure

Project is divided into 2 main folders 
 - `client`: it contains react code using `vite` and all the logic related to ui
 - `server`: here is our wwbsocket server. 

in both the folders there is one common file name `rga.ts`. 
it is the core engine of handling all the operations performed by the user on the editor ui. i'll walk you through this file very soon. 

## Running Locally

to run the project locally 
- clone the repo
- `cd client && bun i && bun dev`
- in a new terminal `cd server && bun i && bun index.ts`

now open the browser `http://localhost:5173` and test it. 

---

## rga.ts - The Core Engine

this file contains the core logic of CRDT where all the insertion, deletion and merge logic rest. 

let's understand it step-by-step

### Type Definitions

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

### IDGenerator

next section is the `IDGenrator` class, that generates the id for each of the node (in very simple -> charcter typed by the user). 
`next`: generates the next id
`update`: update the current id with the remote id in order to sync them, this function is necessary beacuse lets say 
user a is online and idle -> the counter is still at 0
user b types -> 100 words -> the counter is at 100
user a types now -> counter must update from 0 -> x

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

### Node Class

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

### RGA Class

now the next class is `RGA` class that is the main class consisting all the functions related to insertiona and deletion. let's see the important ones

#### Initialization

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

#### compareIds

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

#### localInsert

this function runs when inserting the local changes, this ultimately use the `remoteInsert` thst is used to insret the incoming change / node
```ts
    localInsert(index: number, character: string): Node {
        const parentNode = index > 0 ? this.findVisibleNode(index - 1) : this.head();
        const nextId = this.idGenerator.next();
        return this.remoteInsert(nextId, character, parentNode.id);
    }
```

#### localDelete and remoteDelete

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

this runs when we get signal that someone deleted the node, it first finds the node by id and then mark it true if not yet done

this function is idempotent
```ts
 remoteDelete(id: ID): void {
        const node = this.findById(id);
        if (node && !node.tombstone) node.tombstone = true;
    }
```

#### Formatting (localSetMark / remoteSetMark)

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

#### remoteInsert

now this is out most important function. we've noticed that local insert are eve calling this, the reason behind is 
the cris-cross of operations and getting the parentid
i.e user a change must also be implmeneted by user b and vice versa. 

i broke this function in parts

1. check of the duplicate nodes that gives it idempotent nature.
2. second is update the id if the remote and local id are out of sync
3. then create a node to insert and find the parent node.
4. a while loop which traverse from bottom to down in search of actual parent
5. last is insertion itself


1 and 2 parts are clear in thmeselves, i'll start with 3.
```
2 users a and b, let's say user a wrote abc and the orignal doc is "abc"
orignal doc -> abc
// the nodes are therefore stored in teh following way
idx     id     character
0      HEAD     ""
1      A 1      a
2      A 2      b
3      A 3      c

user a types -> d
user b types -> e

now when user a has typed "d" following events take place
  localInsert(4, "d") -> this fetch the parent i.e (A_3 , "c")
  remoteInsert(A_4, "d", A_3)
    now under remoteInsert it passes through all the parts i mentioned above
    therfore, parentIdx = 3 => insertIdx = 4
    check (insertIdx < len(nodes_array)) => (4 < 4) = false
    hence insert at the 4th postion 
after all this the final document is currently = "abcd"

same things happen when the user b typed "e"
  localInsert(4, "e") -> this fetch the parent i.e (A_3, "c") 
  remoteInsert(B_1, "e", A_3)
  now under remoteInsert it passes through all the parts i mentioned above
  hence, parentIdx = 3 => insertIdx = 4
    check (insertIdx < len(nodes_array)) => (4 < 4) = false
    hence insert at the 4th postion 
and the final document becomes "abce"

now the operations are criss crossed via websockets 
user a recieves user b operationa and vice versa

user a got user b operation
current doc -> abcd
operation = remoteInsert(B_1, "e", A_3)
  - it again checks for dupes
  - parentIdx = 3 and insertIdx = 4
  - check (insertIdx < len(nodes_array)) => (4 < 5) = true
     now here we check if the node is the direct child of the parent if not then travel upwards until you find one
     after the check we got that it is the direct child of the parent 
     then we compare id's use comapreId function compareId(A_4, B_1) => 4 > 1
     hence the order will be "abcde"


user b got user a operation
current doc -> abce
operation = remoteInsert(A_4, "d", "A_3")
all the checks similar to the above
parentIdx = 3 => insertIdx = 4
and finally send in compareId(A_4, B_1) => 4 > 1
insert at 4 => abcde

```

this shows no matter the operations are been merged they results in the same state and hence the logic is commutative too.


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

## CRDT Properties

for a data structure to be a CRDT it must satisfy 3 properties. let's prove each with examples.


the detailed explanation and dry run is already done in the above sections
### Commutativity

`merge(A, B) = merge(B, A)` — the order of merging two states does not matter.

```
base state: "ab"

user a types "x" after "a"  -> A_1 {replica:'A', seq:1, parent:'HEAD'}
user b types "y" after "a"  -> B_1 {replica:'B', seq:1, parent:'HEAD'}

state a = [HEAD, A_1("x"), A_2("b")]
state b = [HEAD, B_1("y"), B_2("b")]
```

**merge(A, B):**
1. load A -> nodes: [HEAD, A_1("x"), A_2("b")]
2. load B -> B_1("y") parent is HEAD, walks past A_1("x")
   - compareIds(B_1, A_1) -> seq 1 == 1, compare replica 'B' > 'A' -> true
   - B_1 goes after A_1
   - result: [HEAD, A_1("x"), B_1("y"), "b"]

**merge(B, A):**
1. load B -> nodes: [HEAD, B_1("y"), B_2("b")]
2. load A -> A_1("x") parent is HEAD, walks past B_1("y")
   - compareIds(A_1, B_1) -> seq 1 == 1, compare replica 'A' > 'B' -> false
   - A_1 goes before B_1
   - result: [HEAD, A_1("x"), B_1("y"), "b"]

both produce `"xyb"` or `"xby"` depending on id comparison — **same result regardless of merge order**.

### Associativity

`merge(merge(A, B), C) = merge(A, merge(B, C))` — grouping does not matter.

```
base state: ""

user A inserts "1" at root -> A_1
user B inserts "2" at root -> B_1
user C inserts "3" at root -> C_1

state A = [HEAD, A_1("1")]
state B = [HEAD, B_1("2")]
state C = [HEAD, C_1("3")]
```

**left side: merge(merge(A, B), C)**
1. merge(A, B):
   - load A: [HEAD, A_1("1")]
   - load B: B_1("2") parent is HEAD, compareIds(B_1, A_1)
     - seq 1 == 1, 'B' > 'A' -> B_1 goes after A_1
   - result: [HEAD, A_1("1"), B_1("2")]
2. merge with C:
   - load C: C_1("3") parent is HEAD, walks past A_1 and B_1
   - compareIds(C_1, A_1): seq 1 == 1, 'C' > 'A' -> after A_1
   - compareIds(C_1, B_1): seq 1 == 1, 'C' > 'B' -> after B_1
   - result: [HEAD, A_1("1"), B_1("2"), C_1("3")]

**right side: merge(A, merge(B, C))**
1. merge(B, C):
   - load B: [HEAD, B_1("2")]
   - load C: C_1("3") after B_1
   - result: [HEAD, B_1("2"), C_1("3")]
2. merge with A:
   - load A: A_1("1") parent is HEAD
   - compareIds(A_1, B_1): seq 1 == 1, 'A' > 'B' -> false -> before B_1
   - compareIds(A_1, C_1): seq 1 == 1, 'A' > 'C' -> false -> before C_1
   - result: [HEAD, A_1("1"), B_1("2"), C_1("3")]

both produce `"123"` — **grouping does not affect the result**.

### Idempotency

`merge(A, A) = A` — merging a state with itself is a no-op.

```
state A = [HEAD, A_1("x"), A_2("y")]
```

**merge(A, A):**
1. load A -> nodes: [HEAD, A_1("x"), A_2("y")]
2. load A again:
   - A_1("x"): `findById(A_1)` returns the existing node -> **duplicate check passes, skip**
   - A_2("y"): `findById(A_2)` returns the existing node -> **duplicate check passes, skip**
   - result: [HEAD, A_1("x"), A_2("y")]

same state, **no duplicates, no change**.

## tests
test file is present in `server/rga.test.ts`
it tests the several cases of concurrent formatting on a single document 
example
- 10 concurrent wqrites
- 5 concurrent wites and 5 deletes
- etc...

after this there are some utility functions such as 
merge(): it merges the 2 document by calling remoteInsert()
mergeAll(): it call merge() to merge given number of states
makeReplicas(): create n number of replica with a base text

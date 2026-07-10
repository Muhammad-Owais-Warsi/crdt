import { describe, expect, test } from "bun:test";
import { RGA, merge } from "./rga";

function make_RGApair(aId: string, bId: string, baseText: string) {
    const a = new RGA(aId);
    const b = new RGA(bId);
    for (const ch of baseText) {
        const op = a.localInsert(a.toString().length, ch);
        b.remoteInsert(op.id, op.character, op.parent!);
    }
    return { a, b };
}

function makeReplicas(count: number, baseText: string): RGA[] {
    const seed = new RGA("seed");
    for (const ch of baseText) seed.localInsert(seed.toString().length, ch);
    const snap = seed.serialize();
    const replicas: RGA[] = [];
    for (let i = 0; i < count; i++) {
        const r = new RGA(`U${i}`);
        r.loadState(snap);
        replicas.push(r);
    }
    return replicas;
}

function mergeAll(replicas: RGA[]): RGA {
    let acc = replicas[0].serialize();
    for (let i = 1; i < replicas.length; i++) {
        acc = merge(acc, replicas[i].serialize()).serialize();
    }
    return merge(replicas[0].serialize(), acc);
}

describe("merge: 10+ concurrent users", () => {
    test("10 users all insert at the same position concurrently", () => {
        const users = makeReplicas(10, "ab");

        // each user inserts their letter between "a" and "b"
        const letters = "CDEFGHIJK";
        for (let i = 0; i < 9; i++) {
            users[i].localInsert(1, letters[i]);
        }

        const result = mergeAll(users).toString();
        expect(result).toContain("a");
        expect(result).toContain("b");
        for (let i = 0; i < 9; i++) expect(result).toContain(letters[i]);
        expect(result.length).toBe(11);
    });

    test("10 users all delete different characters", () => {
        const users = makeReplicas(10, "abcdefghij");

        // each user deletes one different character
        for (let i = 0; i < 10; i++) {
            users[i].localDelete(i);
        }

        const result = mergeAll(users).toString();
        expect(result).toBe("");
    });

    test("5 users insert, 5 users delete concurrently on shared base", () => {
        const users = makeReplicas(10, "hello");

        // users 0-4 each append a digit
        for (let i = 0; i < 5; i++) {
            users[i].localInsert(5, `${i}`);
        }

        // users 5-9 each delete position 0 ("h"); since all 5 target the same
        // underlying node, it is deterministically removed after merge
        for (let i = 5; i < 10; i++) {
            users[i].localDelete(0);
        }

        const result = mergeAll(users).toString();
        expect(result).not.toContain("h");
        for (const ch of "01234") expect(result).toContain(ch);
        for (const ch of "elo") expect(result).toContain(ch);
        expect(result.length).toBe(9); // "ello" + 5 digits
    });

    test("10 users all insert at root concurrently", () => {
        const users = makeReplicas(10, "");

        for (let i = 0; i < 10; i++) {
            users[i].localInsert(0, `${i}`);
        }

        const result = mergeAll(users).toString();
        expect(result.length).toBe(10);
        for (let i = 0; i < 10; i++) expect(result).toContain(`${i}`);

        // commutativity: different merge order gives same result
        let acc2 = users[9].serialize();
        for (let i = 8; i >= 0; i--) {
            acc2 = merge(acc2, users[i].serialize()).serialize();
        }
        expect(merge(users[9].serialize(), acc2).toString()).toBe(result);
    });

    test("10 users all toggle bold on the same character", () => {
        const users = makeReplicas(10, "x");

        for (let i = 0; i < 10; i++) {
            users[i].localSetMark(0, 1, "bold", i % 2 === 0);
        }

        const result = mergeAll(users);
        expect(result.toString()).toBe("x");

        // Last-writer-wins is a deterministic max over op ids, so whichever
        // op ends up "greatest" must win regardless of merge order.
        const forwardBold = result.getRuns()[0].bold;

        let acc2 = users[9].serialize();
        for (let i = 8; i >= 0; i--) {
            acc2 = merge(acc2, users[i].serialize()).serialize();
        }
        const reversed = merge(users[9].serialize(), acc2);
        expect(reversed.toString()).toBe("x");
        expect(reversed.getRuns()[0].bold).toBe(forwardBold);
    });

    test("10 users: mix of inserts, deletes, and formatting", () => {
        const users = makeReplicas(10, "abc");

        users[0].localInsert(0, "X");
        users[1].localInsert(3, "Y");
        users[2].localDelete(1);
        users[3].localSetMark(0, 1, "bold", true);
        users[4].localSetMark(2, 3, "italic", true);
        users[5].localInsert(2, "Z");
        users[6].localDelete(2);
        users[7].localSetMark(1, 2, "bold", true);
        users[7].localSetMark(1, 2, "italic", true);
        users[8].localInsert(1, "W");
        users[9].localDelete(0);

        const result = mergeAll(users);

        // commutativity
        let acc2 = users[9].serialize();
        for (let i = 8; i >= 0; i--) {
            acc2 = merge(acc2, users[i].serialize()).serialize();
        }
        const result2 = merge(users[9].serialize(), acc2);
        expect(result.toString()).toBe(result2.toString());

        // a, b, c are each deleted by exactly one user; X, W, Z, Y are new
        // inserts, so the visible text always converges to those 4 chars
        const text = result.toString();
        expect(text.length).toBe(4);
        expect(text).not.toContain("a");
        expect(text).not.toContain("b");
        expect(text).not.toContain("c");
        for (const ch of "XWZY") expect(text).toContain(ch);
    });

    test("10 users: offline then reconnect merge", () => {
        const users = makeReplicas(10, "base");

        // all 10 go offline and each appends their ID
        for (let i = 0; i < 10; i++) {
            users[i].localInsert(4, `${i}`);
        }

        const result = mergeAll(users).toString();
        expect(result.length).toBe(14);
        expect(result).toContain("b");
        expect(result).toContain("a");
        expect(result).toContain("s");
        expect(result).toContain("e");
        for (let i = 0; i < 10; i++) expect(result).toContain(`${i}`);
    });


    test("10 users: all delete all chars on shared base", () => {
        const users = makeReplicas(10, "ABCDE");

        for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 5; j++) {
                users[i].localDelete(0);
            }
        }

        const result = mergeAll(users).toString();
        expect(result).toBe("");
    });

    test("10 users: concurrent insert chains at different positions", () => {
        const users = makeReplicas(10, "m");

        // each user inserts their own letter right after "m", concurrently
        for (let i = 0; i < 10; i++) {
            const p = String.fromCharCode(65 + i);
            users[i].localInsert(1, p);
        }

        const result = mergeAll(users).toString();
        expect(result.length).toBe(11); // "m" + 10 letters
        expect(result[0]).toBe("m");
        for (let i = 0; i < 10; i++) {
            expect(result).toContain(String.fromCharCode(65 + i));
        }

        // fold order must not affect the converged result
        let acc2 = users[9].serialize();
        for (let i = 8; i >= 0; i--) {
            acc2 = merge(acc2, users[i].serialize()).serialize();
        }
        expect(merge(users[9].serialize(), acc2).toString()).toBe(result);
    });
});

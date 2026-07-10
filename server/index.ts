import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { RGA, type ID, type MarkType, type SerializedNode } from "./rga";

interface InsertMessage {
    type: "insert";
    id: ID;
    character: string;
    parentId: ID;
}

interface DeleteMessage {
    type: "delete";
    id: ID;
}

interface MarkMessage {
    type: "mark";
    targetId: ID;
    mark: MarkType;
    value: boolean;
    opId: ID;
}

type ClientMessage = InsertMessage | DeleteMessage | MarkMessage;

interface CursorMessage {
    type: "cursor";
    position: number;
    color: string;
}

interface SyncMessage {
    replica: string;
    nodes: SerializedNode[];
    replicas: string[];
}

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
    },
});

app.get("/", (req, res) => {
    res.send("<h1>Hello world</h1>");
});

// The server holds one shared RGA replica so it can (a) reconstruct the
// current document for anyone who connects, and (b) merge every op it
// relays, so its own copy always matches what clients converge to.
const doc = new RGA("server");
const replicas = new Set<string>();

io.on("connection", (socket) => {
    const replica = socket.id;
    console.log(`${replica} connected`);

    const sync: SyncMessage = {
        replica,
        nodes: doc.serialize(),
        replicas: [...replicas],
    };
    socket.emit("sync", sync);

    replicas.add(replica);
    socket.broadcast.emit("new-replica", replica);

    socket.on("crdt-op", (op: ClientMessage) => {
        if (op.type === "insert") {
            doc.remoteInsert(op.id, op.character, op.parentId);
        } else if (op.type === "delete") {
            doc.remoteDelete(op.id);
        } else if (op.type === "mark") {
            doc.remoteSetMark(op.targetId, op.mark, op.value, op.opId);
        }

        socket.broadcast.emit("crdt-op", op);
    });

    socket.on("cursor-op", (op: CursorMessage) => {
        socket.broadcast.emit("cursor-op", { ...op, id: replica });
    });

    socket.on("full-sync", (nodes: SerializedNode[]) => {
        console.log(`${replica} full-sync (${nodes.length} nodes)`);
        doc.loadState(nodes);
        socket.broadcast.emit("full-sync", nodes);
    });

    socket.on("disconnect", () => {
        replicas.delete(replica);
        socket.broadcast.emit("replica-left", replica);
        console.log(`${replica} disconnected`);
    });
});

io.listen(4000);
server.listen(3000, () => {
    console.log("server running at http://localhost:3000");
});

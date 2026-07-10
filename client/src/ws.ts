import { io } from "socket.io-client";
import type { ID, MarkType, SerializedNode } from "./rga";

export interface SyncMessage {
    replica: string;
    nodes: SerializedNode[];
    replicas: string[];
}

export interface InsertOp {
    type: "insert";
    id: ID;
    character: string;
    parentId: ID;
}

export interface DeleteOp {
    type: "delete";
    id: ID;
}

export interface MarkOp {
    type: "mark";
    targetId: ID;
    mark: MarkType;
    value: boolean;
    opId: ID;
}

export type CrdtOp = InsertOp | DeleteOp | MarkOp;

export interface CursorOp {
    type: "cursor";
    position: number;
    color: string;
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

export const socket = io(SERVER_URL, {
    reconnectionDelay: 1000,
    reconnectionDelayMax: 3000,
    timeout: 5000,
});

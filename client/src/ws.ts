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

export const socket = io("http://localhost:4000");

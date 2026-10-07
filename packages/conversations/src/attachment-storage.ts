export interface ConversationFileStorage {
  put(input: {
    id: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<string>;
  get(reference: string): Promise<Uint8Array | null>;
  /** Idempotent: deleting an absent object must succeed so metadata cleanup can be retried. */
  delete(reference: string): Promise<void>;
}

export interface ConversationInputAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  url: string;
}

export interface ConversationUpload {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

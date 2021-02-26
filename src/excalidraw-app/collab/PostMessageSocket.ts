import { EventEmitter } from "events";
import { nanoid } from "nanoid";

export default class PostMessageSocket extends EventEmitter {
  origEmit: (eventName: string, ...args: any[]) => boolean;
  id = nanoid();
  close() {
    this.origEmit("close");
  }
  constructor() {
    super();
    this.origEmit = this.emit;
    if (window === window.parent) {
      this.emit = (eventName: string | symbol, ...args: any[]): boolean => {
        return true;
      };
      console.warn("We are the parent, bail");
      return;
    }

    this.emit = (eventName: string | symbol, ...args: any[]): boolean => {
      window.parent.postMessage(
        {
          type: "wb_broadcast",
          eventName,
          args,
        },
        "*",
      );
      return true;
    };
    const onMessage = ({ data: message }: MessageEvent) => {
      try {
        if (message.type === "wb_broadcast") {
          this.origEmit(message.eventName, ...message.args);
        }
      } catch (err) {
        console.warn("Could not decode window message", err);
      }
    };

    window.addEventListener("message", onMessage);

    this.once("close", () => {
      window.removeEventListener("message", onMessage);
    });
  }
}

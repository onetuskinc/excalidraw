import { EventEmitter } from "events";
import { nanoid } from "nanoid";

export default class PostMessageSocket extends EventEmitter {
  origEmit: (eventName: string, ...args: any[]) => boolean;
  id = nanoid();
  close() {
    this.emit("close");
  }
  constructor() {
    super();
    this.origEmit = this.emit;

    this.emit = (eventName: string | symbol, ...args: any[]): boolean => {
      window.parent.postMessage(
        JSON.stringify({
          type: "wb_broadcast",
          eventName,
          args,
        }),
        "*",
      );
      return true;
    };
    const onMessage = ({ data }: MessageEvent) => {
      try {
        const message = JSON.parse(data);
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

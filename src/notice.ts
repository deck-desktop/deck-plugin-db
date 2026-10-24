// What this plugin tells the user, through Deck's notifications, so Settings › Notifications
// decides where each goes. A result the user just asked for is a card that goes by itself and is
// not kept in the bell; a failure is kept.
import { notify } from "../shim/ui.js";

const source = "Databases";
export const notice = (title: string) => void notify({ kind: "activity", source, title, transient: true });
export const failure = (title: string, body?: string) => void notify({ kind: "error", source, title, body });

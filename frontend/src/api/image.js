// frontend/src/api/image.js
import { client } from "./client.js";
export const fetchImages = () => client.get("/images");
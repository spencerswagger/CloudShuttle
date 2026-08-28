// frontend/src/api/image.js
import { client } from "./client.js";
export const fetchImages = () => client.get("/images");
export const createImage = (d) => client.post("/images", d);
export const updateImage = (id, d) => client.put(`/images/${id}`, d);
export const deleteImage = (id) => client.delete(`/images/${id}`);
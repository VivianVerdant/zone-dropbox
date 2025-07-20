import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.defaults" });

process.title = "zone dropbox";

const options = {
	host: process.env.HOST ?? "127.0.0.1",
	port: parseInt(process.env.PORT ?? "4003"),
};

process.on("SIGINT", () => {
	save();
	process.exit();
});

import { parse, join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";

import { LowSync } from "lowdb";
import { JSONFileSync } from "lowdb/node";

const db = new LowSync(new JSONFileSync(process.env.DATA_PATH));
db.read();
db.data ||= { entries: [] };
db.write();

const library = new Map(db.data.entries);

function save() {
	db.data.entries = Array.from(library);
	db.write();
}

async function getMediaDurationInSeconds(file) {
	const info = await ffprobe(file, { path: ffprobeStatic.path });
	return info.streams[0].duration ?? 0;
}

import express from "express";
import fileUpload from "express-fileupload";

import ffprobe from "ffprobe";
import ffprobeStatic from "ffprobe-static";

import joi from "joi";
import glob from "glob";
import { nanoid } from "nanoid";
import srt2vtt from "srt-to-vtt";
import { Readable } from "node:stream";

const app = express();
app.use(
	fileUpload({
		abortOnLimit: true,
		uriDecodeFileNames: true,
		limits: { fileSize: process.env.UPLOAD_LIMIT_MB * 1024 * 1024 },
	})
);
app.use(express.json());

app.use(express.static("public"));
app.use("/media", express.static("media"));

/**
 * @param {express.Request} request
 * @param {express.Response} response
 * @param {express.NextFunction} next
 */
function requireAuth(request, response, next) {
	console.log(request);
	const auth = request.headers.authorization;

	if (
		auth &&
		auth.startsWith("Bearer") &&
		auth.endsWith(process.env.PASSWORD)
	) {
		next();
	} else if (request.body && request.body.password === process.env.PASSWORD) {
		next();
	} else {
		response.status(401).json({ title: "Invalid password." });
	}
}

app.param("media", (request, response, next, mediaId) => {
	request.libraryEntry = library.get(mediaId);

	if (request.libraryEntry) {
		next();
	} else {
		response.status(404).json({ title: "Entry does not exist." });
	}
});

async function addFromLocalFile(file) {
	const parsed = parse(file);
	const mediaId = nanoid();
	const filename = mediaId + parsed.ext;
	const path = join(MEDIA_PATH, filename);

	await rename(file, path);
	const duration = (await getMediaDurationInSeconds(path)) * 1000;

	const info = {
		mediaId,
		title: parsed.name,
		url,
		duration,
		tags: [],
	};

	library.set(mediaId, info);
	save();
	return info;
}

function withSrc(info) {
	const src = info.url;
	const subtitle = info.subtitle && info.subtitle;

	return { ...info, src, subtitle };
}

function searchLibrary(options) {
	//console.log(options);
	let results = Array.from(library.values());

	if (options.tag) {
		const tag = options.tag.toLowerCase();
		results = results.filter((entry) => entry.tags.includes(tag));
	}

	if (options.q) {
		const search = options.q.toLowerCase();
		results = results.filter((entry) =>
			entry.title.toLowerCase().includes(search)
		);
	}
	//console.log(results);
	return results;
}

// general libraries API
app.get("/dropbox", (request, response) => {
	let entries = searchLibrary(request.query || {});
	response.json(entries.map(withSrc));
});

app.get("/dropbox/:media", (request, response) => {
	response.json(withSrc(request.libraryEntry));
});

app.get("/dropbox/:media/status", (request, response) => {
	response.json("available");
});

app.get("/dropbox/:media/progress", (request, response) => {
	response.json(1);
});

app.post("/dropbox/:media/request", (request, response) => {
	response.status(202).send();
});
//

app.get("/dropbox-limit", async (request, response) => {
	response.json({ limit: process.env.UPLOAD_LIMIT_MB * 1024 * 1024 });
});

app.post("/dropbox/auth", requireAuth, async (request, response) => {
	console.log("logged in with auth");
	response.json({ authorized: true });
});

app.post("/dropbox", requireAuth, async (request, response) => {
	const title = request.body.title;
	const url = request.body.url;
	const mediaId = nanoid();

	//	const duration = (await getMediaDurationInSeconds(path)) * 1000;

	const info = {
		mediaId,
		title: title,
		url: url,
		//		duration,
		tags: [],
	};

	library.set(mediaId, info);
	response.json(withSrc(info));
	save();
});

app.put("/dropbox/:media/subtitles", requireAuth, async (request, response) => {
	const file = request.files.subtitles;
	const filename = request.libraryEntry.mediaId + ".vtt";
	const path = join(MEDIA_PATH, filename);

	if (file.name.endsWith(".vtt")) {
		await file.mv(path);
	} else {
		// don't know how to await this properly
		const read = file.data
			? Readable.from(file.data.toString())
			: createReadStream(file.tempFilePath);
		read.pipe(srt2vtt())
			.pipe(createWriteStream(path))
			.on("error", (e) => console.log("SUBTITLE FAILED: ", e));
	}

	request.libraryEntry.subtitle = filename;
	response.json(withSrc(request.libraryEntry));
	save();
});

const tagSchema = joi.string().lowercase().min(1).max(32);
const patchSchema = joi.object({
	setTitle: joi.string().min(1).max(128),
	addTags: joi.array().items(tagSchema).default([]),
	delTags: joi.array().items(tagSchema).default([]),
});

app.patch("/dropbox/:media", requireAuth, (request, response) => {
	const { value: actions, error } = patchSchema.validate(request.body);

	if (error) {
		response.status(400).json(error);
	} else {
		if (actions.setTitle) request.libraryEntry.title = actions.setTitle;

		const tags = new Set(request.libraryEntry.tags);
		actions.addTags.forEach((tag) => tags.add(tag));
		actions.delTags.forEach((tag) => tags.delete(tag));
		request.libraryEntry.tags = Array.from(tags);

		response.json(withSrc(request.libraryEntry));
		save();
	}
});

app.delete("/dropbox/:media", requireAuth, async (request, response) => {
	library.delete(request.libraryEntry.mediaId);
	save();

	let entries = searchLibrary(request.query || {});
	response.json(entries.map(withSrc));
});

const listener = app.listen(options.port, options.host, () => {
	console.log(
		`${process.title} serving on http://${listener.address().address}:${
			listener.address().port
		}`
	);
});

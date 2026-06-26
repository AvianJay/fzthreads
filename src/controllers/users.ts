import express from "express";
import { HttpError, getThreadsUrl } from "../utils/utils";
import findUser from "../utils/fetch/findUser";
import renderSeo from "../utils/renderSeo";
const router: express.Router = express.Router();

router.get("/@:username", async (req, res, next) => {
  const username = req.params.username;
  try {
    if (!username)
      return next(new HttpError(400, "No user provided"));

    const user = await findUser({
      username: username,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!user || !user.title) {
      return next(new HttpError(404, "User not found"));
    }

    return res.send(
      renderSeo({
        type: "user",
        content: user,
      })
    );
  } catch (e: any) {
    if (username) {
        return res.redirect(getThreadsUrl(username));
    }
    return res.redirect("/");
  }
});

export default router;

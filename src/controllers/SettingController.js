const fs = require("fs");
const jwt = require("jsonwebtoken");

const { BotTheme, BotSetting, Model, Visible, } = require("../models/SettingModel");

const { ChatbotHistory } = require("../models/ChatbotHistoryModel");
const resMsg = require("../helpers/responseMessage");
const embedding = require("../helpers/utility");
const { ObjectId } = require("mongodb");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { TokenTextSplitter } = require("langchain/text_splitter");
const { PineconeClient } = require("@pinecone-database/pinecone");
const { PineconeStore } = require("langchain/vectorstores/pinecone");
const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
const { PuppeteerWebBaseLoader, } = require("langchain/document_loaders/web/puppeteer");

const puppeteer = require("puppeteer");

const { SUCCESS, SERVERERROR, } = require("../constants/errorCode");
const { SERVERERRORMSG, } = require("../constants/errorMessage");
const path = require("path");

require("dotenv").config();

var subURLs = [];
var url_count = 0;
var check_url = [];
var all_resultURLs = [];

exports.create = async (req, res) => {
  try {
    let { chatbot_name, embedding_type = 0, content, chatbot_id, is_create = true, } = req.body;
    let nonexistFlag = false;
    let response = "success";

    //*********embedding***********

    if (embedding_type == 0 && req.files.file != null) {
      chatbot_name = req.files.file.name;
    } else if (embedding_type == 1) {
      chatbot_name = chatbot_name;
    }

    const saveData = {
      chatbot_name: chatbot_name,
      characters_number: parseInt(2000),
      base_prompt: process.env.BASE_PROMPT,
      rate_msg: parseInt(process.env.ONLY_MSG),
      rate_second: parseInt(process.env.EVERY_SECONDS),
      limit_msg: process.env.LIMIT_MSG,

      interface_init_msg: process.env.INIT_MSG,
      interface_suggest_msg: process.env.SUGGESTED_MESSAGES,
      remove_profile_picture: false,
      remove_icon: false,
      align_bubble_btn: process.env.ALIGN_BUBBLE_BTN,
      auto_msg_second: parseInt(process.env.AUTO_MSG_SECONDS),
      bubble_btn_color: process.env.BUBBLE_BTN_COLOR,
      user_msg_color: process.env.USER_MSG_COLOR,
    };

    const model = await Model.find();


    if (model.length == 0) {
      nonexistFlag = true;
    } else {
      saveData.model = model[0]._id;
    }

    const visibility = await Visible.find();

    if (visibility.length == 0) {
      nonexistFlag = true;
    } else {
      saveData.visibility = visibility[0]._id;
    }

    const theme = await BotTheme.find();

    if (theme.length == 0) {
      nonexistFlag = true;
    } else {
      saveData.theme = theme[0]._id;
    }

    if (nonexistFlag) {
      response = "server error";
    }

    let result;
    if (is_create) {
      result = await BotSetting.create(saveData);
    }
    else {
      result = await BotSetting.findByIdAndUpdate(
        new ObjectId(chatbot_id),
        { chatbot_name: chatbot_name },
        { new: true }
      );
    }

    let user_id = "64ed9ce8f6ad1e1dec165d35";
    let token = req.headers["x-auth-token"];

    if (!token) {
      return res.status(403).send({ message: "No token provided!" });
    }

    jwt.verify(token, process.env.token_key, (err, decoded) => {
      if (err) {
        return res.status(401).status({ message: "Unauthorized!", });
      }
      user_id = decoded.id;
    });

    if (is_create) {
      const user = await ChatbotHistory.create({ user_id: new ObjectId(user_id), chatbot_id: result._id, })
    }

    if (embedding_type == 0) {
      //********file upload **********/
      const file = req.files.file;
      const filename = file.name;
      let numberCharacters = 0;

      const srcDir = path.join(__dirname, '..')
      const destinationPath = path.join(`${srcDir}/uploads`, filename);

      try {
        await file.mv(destinationPath); // Use await with file.mv

        console.log('File saved successfully');

        const loader = new PDFLoader(destinationPath, {
          splitPages: false,
          pdfjs: () => import("pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js"),
        });

        const docs = await loader.load();
        console.log('docs>>>>>>>>>>', docs);

        fs.unlink(destinationPath, (err) => {
          if (err) throw err
        });

        const splitter = new TokenTextSplitter({ chunkSize: 1000, chunkOverlap: 0, });

        const output = await splitter.createDocuments([docs[0].pageContent]);
        numberCharacters = docs[0].pageContent.length;

        // vectorDoc = vectorDoc.concat(output);
        const client = new PineconeClient();

        let state = await client.init({
          apiKey: process.env.PINECONE_API_KEY,
          environment: process.env.PINECONE_ENVIRONMENT,
        });

        const pineconeIndex = client.Index(process.env.PINECONE_INDEX);
        await PineconeStore.fromDocuments(output, new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }), { pineconeIndex, namespace: result._id });
        BotSetting.findByIdAndUpdate(result._id,
          { characters_number: numberCharacters },
          { new: true }
        )
          .then((updatedDocument) => console.log('updatedDocument0000', updatedDocument))
          .catch((error) => console.log('error>>:error>>', error));
      } catch (err) {
        console.error('Error saving the file:', err);
      }

      res.status(200).json({ data: response, });

    } else if (embedding_type == 1) {
      const splitter = new TokenTextSplitter({ chunkSize: 1000, chunkOverlap: 0 });

      let output = await splitter.createDocuments([content]);

      const client = new PineconeClient();
      await client.init({ apiKey: process.env.PINECONE_API_KEY, environment: process.env.PINECONE_ENVIRONMENT });

      const pineconeIndex = client.Index(process.env.PINECONE_INDEX);
      // await PineconeStore.fromDocuments(
      //   output,
      //   new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }),
      //   { pineconeIndex, namespace: result._id }
      // );

      await PineconeStore.fromDocuments(output,
        new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }),
        { pineconeIndex, namespace: result._id }
      )
      BotSetting.findByIdAndUpdate(result._id, { characters_number: content.length }, { new: true })
        .then((updatedDocument) => console.log('updatedDocument>>>>>>>>', updatedDocument))
        .catch((error) => console.log(error));

      res.status(200).json({ data: response, });

      // try {
      //   const response = await PineconeStore.fromDocuments(
      //     output,
      //     new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }),
      //     { pineconeIndex, namespace: result._id }
      //   );
      //   console.log('PineconeStore.fromDocuments response>>>>>>:', response);

      //   BotSetting.findByIdAndUpdate(
      //     result._id,
      //     { characters_number: content.length },
      //     { new: true }
      //   )
      //     .then((updatedDocument) => {
      //       console.log('updatedDocument>>>>>>>>', updatedDocument);
      //     })
      //     .catch((error) => {
      //       console.log(error);
      //     });

      //   res.status(200).json({
      //     data: response,
      //   });

      // } catch (error) {
      //   console.error('PineconeStore.fromDocuments error:??????????????>>>>>> ', error);
      // }
    }

  } catch (error) {
    return res.status(400).json({ status: "error", error: error, });
  }
};

exports.upload = async (req, res) => {
  if (!req.files.length) {
    res.status(400).send({ message: "Content can not be empty!" });
    return;
  }

  if (req.files.length === idx + 1)
    res.send({ message: "File uploaded successfully" });
};

exports.get = async (req, res) => {
  try {
    const chatbot_id = req.params.chatbot_id
    const setting = await BotSetting.findById(chatbot_id)
      .populate("model")
      .populate("visibility")
      .populate("theme");

    const model = await Model.find();

    const visibility = await Visible.find();

    const data = {
      setting: setting,
      model: model,
      visibility: visibility,
    };

    return resMsg(res, 200, data);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.iconUpload = async (req, res) => {
  try {
    const Icon = req.files.Icon;
    const newPath = "./public/";

    const IconName = Icon.name;
    await Icon.mv(`${newPath}${IconName}`, async (err) => {
      if (err) {
        console.log(err);
        return resMsg(res, 500, "Server error");
      }
      return resMsg(res, 200, {
        iconName: "http://localhost:8080/" + IconName,
      });
    });
  } catch (err) {
    console.log(err);
    return resMsg(res, 500, "Server error");
  }
};

exports.updateSetting = async (req, res) => {
  try {
    const { chatbot_id, sendData } = req.body;
    const chatbotId = chatbot_id

    await BotSetting.updateOne({ _id: chatbotId }, { $set: req.body });

    return resMsg(res, 200, "success");
  } catch (err) {

    console.log(err);
  }
};

exports.replaceData = async (req, res) => {
  try {
    const { chatbot_id, embedding_type } = req.body;

    if (embedding_type == 0) {
      const reqFiles = [];
      let vectorDoc = [];
      const url = req.protocol + "://" + req.get("host");

      for (var i = 0; i < req.files.length; i++) {
        reqFiles.push(url + "/public/" + req.files[i].filename);

        const loader = new PDFLoader("public/" + req.files[i].filename, {
          splitPages: false,
          pdfjs: () => import("pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js"),
        });
        const docs = await loader.load();

        const splitter = new TokenTextSplitter({ chunkSize: 1000, chunkOverlap: 0 });

        const output = await splitter.createDocuments([docs[0].pageContent]);
        vectorDoc = vectorDoc.concat(output);
      }

      const client = new PineconeClient();

      await client.init({
        apiKey: process.env.PINECONE_API_KEY,
        environment: process.env.PINECONE_ENVIRONMENT,
      });
      const pineconeIndex = client.Index(process.env.PINECONE_INDEX);

      await PineconeStore.fromDocuments(
        vectorDoc,
        new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }),
        { pineconeIndex, namespace: chatbot_id }
      );
    } else if (embedding_type == 1) {
      embedding(content, chatbot_id);
    } else if (embedding_type == 2) {
      embedding(content, chatbot_id);
    }
    return resMsg(res, 200, chatbot_id);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.getChatList = async (req, res) => {
  try {
    let token = req.headers["x-auth-token"];
    let user_id = "";
    if (!token) {
      return res.status(403).send({
        message: "No token provided!",
      });
    }

    jwt.verify(token, process.env.token_key, (err, decoded) => {
      if (err) {
        return res.status(401).status({
          message: "Unauthorized!",
        });
      }
      user_id = decoded.id;
    });

    ChatbotHistory.find({ user_id: user_id })
      .populate("chatbot_id")
      .then((chatbotlist) => {
        const resData = [];
        chatbotlist.forEach((element) => {
          resData.push({
            chatbot_id: element.chatbot_id._id,
            chatbot_name: element.chatbot_id.chatbot_name,
          });
        });
        return res.status(SUCCESS).json(resData);
      })
      .catch((err) => {
        return res.status(SERVERERROR).json({ message: SERVERERRORMSG });
      });
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.get_embedded_visiblelist = async (req, res) => {
  try {
    const visiblelist = await Visible.find();
    const resData = [];
    for (let index = 1; index < visiblelist.length; index++) {
      resData.push(visiblelist[index]);
    }
    return resMsg(res, 200, resData);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.update_embedded_visible = async (req, res) => {
  try {
    const { chatbot_id, visible } = req.body;

    const setting = await BotSetting.updateOne(
      { _id: chatbot_id },
      { $set: { visibility: visible } }
    );
    return resMsg(res, 200, setting);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.update_embedded_domains = async (req, res) => {
  try {
    const { chatbot_id, domains } = req.body;
    const setting = await BotSetting.updateOne(
      { _id: chatbot_id },
      { $set: { domain: domains } }
    );
    return resMsg(res, 200, setting);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.delete_chatbot = async (req, res) => {
  try {
    const { chatbot_id } = req.body;
    const result = await ChatbotHistory.deleteOne({ chatbot_id: chatbot_id });
    await BotSetting.deleteOne({ _id: chatbot_id });
    // const client = new PineconeClient();
    // await client.init({
    //   apiKey: process.env.PINECONE_API_KEY,
    //   environment: process.env.PINECONE_ENVIRONMENT,
    // });
    // const pineconeIndex = client.Index(process.env.PINECONE_INDEX);
    // await pineconeIndex.delete1({ deleteAll: true, namespace: chatbot_id });
    return resMsg(res, 200, "success");
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.share_chatbot = async (req, res) => {
  try {
    const { chatbot_id, require_login } = req.body;
    console.log({ chatbot_id, require_login });

    const visibility_list = await Visible.find();
    const public_id = visibility_list[visibility_list?.length - 1]?._id;
    const setting = await Visible.updateOne({ _id: chatbot_id }, { $set: { visibility: public_id, require_login: require_login } });

    return resMsg(res, 200, "success");
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};

exports.require_login = async (req, res) => {
  try {
    const { chatbot_id } = req.body;

    const chatbot = await BotSetting.findOne({ _id: chatbot_id });
    return resMsg(res, 200, chatbot["required_login"]);
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
};


exports.websrape = async (req, res) => {
  try {
    const { URL, limit_count } = req.body;
    const resourceTypesToBlock = ["stylesheet", "script", "image", "media"];

    let subURLs = [];
    let url_count = 0;
    let all_resultURLs = [];

    const limitcount = parseInt(limit_count);
    // Launch the headless browser
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    // Go to the webpage
    page.setRequestInterception(true);


    page.on("request", (request) => {
      if (resourceTypesToBlock.includes(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.goto(URL);

    subURLs = await page.evaluate(() => {

      const results = [];
      // Select all elements with crayons-tag class
      const items = document.querySelectorAll("a");
      items.forEach((item) => {
        results.push(item.href);
      });
      return Array.from(new Set(results));
    });


    subURLs = subURLs.filter((word) => {
      const startsWithHTTP = word.startsWith("http");
      const notEqualToURL = word !== URL;
      const includesURL = word.includes(URL);
      const endsWithSlash = word.endsWith("/");

      return startsWithHTTP, notEqualToURL, includesURL, endsWithSlash;
    });

    url_count = subURLs.length;

    if (subURLs.length > 0 && url_count < limitcount) {

      all_resultURLs = await getSubURLs(subURLs, subURLs[0], url_count, limitcount, res, URL);
    }
    else {
      return resMsg(res, 200, all_resultURLs);
    }

    await browser.close();

  } catch (err) {
    console.error(err);
    return resMsg(res, 500, "Server error");
  }
};


const check_repeat = (urls, sub_url) => {
  for (var i = 0; i < urls.length; i++) {
    if (urls[i] === sub_url) return true;
  }
  return false;
};

const getSubURLs = (resultURLs, URL, url_count, limitcount, res, find_URL) => {
  return new Promise(async (resolve, reject) => {
    try {
      const browser = await puppeteer.launch();
      const page = await browser.newPage();
      // Go to the webpage
      if (check_repeat(check_url, URL) === false) {

        page.setRequestInterception(true);
        page.on("request", (request) => {
          if (
            request.resourceType() == "stylesheet" ||
            request.resourceType() == "script" ||
            request.resourceType() == "image" ||
            request.resourceType() == "media"
          ) {
            const u = request.url();
            request.abort();
            return;
          }

          request.continue();
        });

        await page.goto(URL);

        check_url.push(URL);

        let subURLs = await page.evaluate(() => {
          // Select all elements with crayons-tag class
          let results = [];
          const items = document.querySelectorAll("a");
          items.forEach((item) => {
            // Get innerText of each element selected and add it to the array
            results.push(item.href);
          });
          return results;
        });

        if (subURLs.length > 0) {
          resultURLs.push(...subURLs);
          resultURLs = [...new Set(resultURLs)];
          resultURLs = resultURLs.filter(
            (word) =>
              word.includes("http") &&
              word.includes(find_URL) &&
              word.at(-1) === "/"
          );

          all_resultURLs = resultURLs;
          url_count = resultURLs.length;

          if (check_url.length === resultURLs.length) {
            console.log("success");
            resolve(resultURLs);
            return resMsg(res, 200, resultURLs);
          }

          if (resultURLs.length > limitcount) {
            console.log("the count is many");
            resolve(resultURLs);
            return resMsg(res, 200, resultURLs.slice(0, limitcount));
          }
          console.log("continue");
          for (var i = 0; i < resultURLs.length; i++)
            if (
              check_repeat(check_url, resultURLs[i]) === false &&
              resultURLs.length < limitcount
            )
              await getSubURLs(resultURLs, resultURLs[i], url_count, limitcount, res, find_URL);
        }

        else {
          if (check_url[check_url.length - 1] === resultURLs[resultURLs.length - 1]) {
            resolve(resultURLs);
            return resMsg(res, 200, resultURLs);
          }

          for (var i = 0; i < resultURLs.length; i++)

            if (check_repeat(check_url, resultURLs[i]) === false && resultURLs.length < limitcount) {

              await getSubURLs(resultURLs, resultURLs[i], url_count, limitcount, res, find_URL);
            }
        }
      }

      await browser.close();
    }
    catch (err) {
      if (resultURLs.length > 0) {
        resolve(resultURLs);
        resMsg(res, 200, resultURLs);
        return;
      }
      else resMsg(res, 500, "Server error");
    }
  });
};

exports.web_scraping_chatbot = async (req, res) => {
  try {
    const { linkList, is_create = true, chatbot_id, chatbot_name } = req.body;

    let vectorDoc = [];
    let chatbotId = "";

    if (is_create) {
      const saveData = {
        chatbot_name: chatbot_name,
        characters_number: parseInt(2000),
        base_prompt: process.env.BASE_PROMPT,
        rate_msg: parseInt(process.env.ONLY_MSG),
        rate_second: parseInt(process.env.EVERY_SECONDS),
        limit_msg: process.env.LIMIT_MSG,

        interface_init_msg: process.env.INIT_MSG,
        interface_suggest_msg: process.env.SUGGESTED_MESSAGES,
        remove_profile_picture: false,
        remove_icon: false,
        align_bubble_btn: process.env.ALIGN_BUBBLE_BTN,
        auto_msg_second: parseInt(process.env.AUTO_MSG_SECONDS),
        bubble_btn_color: process.env.BUBBLE_BTN_COLOR,
        user_msg_color: process.env.USER_MSG_COLOR,
      };


      const model = await Model.find();
      if (model.length == 0) {
        nonexistFlag = true;
      } else {
        saveData.model = model[0]._id;
      }

      const visibility = await Visible.find();

      if (visibility.length == 0) {
        nonexistFlag = true;
      } else {
        saveData.visibility = visibility[0]._id;
      }

      const theme = await BotTheme.find();
      if (theme.length == 0) {
        nonexistFlag = true;
      } else {
        saveData.theme = theme[0]._id;
      }

      const result = await BotSetting.create(saveData);

      let user_id = "";
      let token = req.headers["x-auth-token"];

      if (!token) {
        return res.status(403).send({
          message: "No token provided!",
        });
      }

      jwt.verify(token, process.env.token_key, (err, decoded) => {
        if (err) {
          return res.status(401).status({
            message: "Unauthorized!",
          });
        }
        user_id = decoded.id;
      });

      const user = await ChatbotHistory.create({ user_id: user_id, chatbot_id: result._id, });
      chatbotId = result._id;
    }
    else { chatbotId = chatbot_id }

    for (let index = 0; index < linkList.length; index++) {
      const element = linkList[index];
      const loader = new PuppeteerWebBaseLoader(element["link"]);
      const docs = await loader.load();

      const splitter = new TokenTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 0,
      });

      const output = await splitter.createDocuments([docs[0].pageContent]);
      vectorDoc = vectorDoc.concat(output);
    }

    const client = new PineconeClient();

    let state = await client.init({
      apiKey: process.env.PINECONE_API_KEY,
      environment: process.env.PINECONE_ENVIRONMENT,
    });

    const pineconeIndex = client.Index(process.env.PINECONE_INDEX);
    await PineconeStore.fromDocuments(vectorDoc, new OpenAIEmbeddings({ openAIApiKey: process.env.OPENAI_API_KEY }), { pineconeIndex, namespace: chatbotId });
    return resMsg(res, 200, "Success");
  } catch (err) {
    return resMsg(res, 500, "Server error");
  }
}
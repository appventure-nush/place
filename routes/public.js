const express = require('express');
const Ratelimit = require('express-brute');
const ratelimitStore = require('../util/RatelimitStore');
const config = require('../config/config');
const jwt = require('jwt-simple');
const passport = require('passport');
require('../util/passport')(passport);
const User = require('../models/user');
const responseFactory = require("../util/ResponseFactory")();

function PublicRouter(app) {
    let router = express.Router()

    router.use(function(req, res, next) { // Force user to pick a username
        if(req.url == "/signout") return next(); // Allow the user to log out
        if(req.url == "/pick-username") return next(); // Allow the user to POST their new username
        if(req.user && !req.user.usernameSet) { // If the user has no username...
            return responseFactory.sendRenderedResponse("pick-username", req, res, {captcha: app.recaptcha.render(), username: req.user.OAuthName.replace(/[^[a-zA-Z0-9-_]/g, "-").substring(0, 20), user: {name: ""}}); // Send the username picker
        }
        next(); // Otherwise, carry on...
    })

    router.post('/pick-username', function(req, res) {
        if(!req.user) res.redirect("/signup");
        if(req.user.usernameSet) res.redirect("/");
        let user = req.user;
        user.name = req.body.username;
        app.recaptcha.verify(req, error => {
            if(error) return responseFactory.sendRenderedResponse("pick-username", req, res, {captcha: app.recaptcha.render(), error: {message: "Please prove your humanity"}, user: {name: ""}, username: req.body.username});
            
            user.setUserName(user.name, function(err) {
                if(err) return responseFactory.sendRenderedResponse("pick-username", req, res, {captcha: app.recaptcha.render(), error: err, username: req.body.name, user: {name: ""}});
                req.login(user, function(err) {
                    if (err) return responseFactory.sendRenderedResponse("public/signin", req, res, {captcha: app.recaptcha.render(), error: { message: "An unknown error occurred." }, username: req.body.username, user: {name: ""}});
                    res.redirect("/?signedin=1");
                });
            });
        });
    })

    const ratelimitCallback = function (req, res, next, nextValidRequestDate) {
        function renderResponse(errorMsg) {
            return responseFactory.sendRenderedResponse("public/signup", req, res, { captcha: app.recaptcha.render(), error: { message: errorMsg || "An unknown error occurred" }, username: req.body.username });
        }
        res.status(429);
        return renderResponse("You're doing that too fast.");
    }

    const handleStoreError = function (error) {
        console.error(error);
    }

    const signupRatelimit = new Ratelimit(ratelimitStore, {
        freeRetries: 3, // 3 signups per hour
        attachResetToRequest: false,
        refreshTimeoutOnRequest: false,
        minWait: 60*60*1000, // 1 hour
        maxWait: 60*60*1000, // 1 hour, 
        failCallback: ratelimitCallback,
        handleStoreError: handleStoreError,
        proxyDepth: config.trustProxyDepth
    });

    router.get('/', function(req, res) {
        return responseFactory.sendRenderedResponse("public/index", req, res);
    })

    router.get('/sitemap.xml', function(req, res, next) {
        if(typeof config.host === undefined) return next();
        return responseFactory.sendRenderedResponse("public/sitemap.xml.html", req, res, null, "text/xml");
    })

    router.get('/signin', function(req, res) {
        if (req.user) return res.redirect("/");
        return responseFactory.sendRenderedResponse("public/signin", req, res);
    })

    router.post('/signin', function(req, res, next) {
        if (req.user) return res.redirect("/");
        if (!req.body.username || !req.body.password) return responseFactory.sendRenderedResponse("public/signin", req, res, { error: { message: "A username and password are required." }, username: req.body.username });
        passport.authenticate('local', function(err, user, info) {
            if (!user) return responseFactory.sendRenderedResponse("public/signin", req, res, { error: info.error || { message: "An unknown error occurred." }, username: req.body.username });
            req.login(user, function(err) {
                if (err) return responseFactory.sendRenderedResponse("public/signin", req, res, { error: { message: "An unknown error occurred." }, username: req.body.username });
                return res.redirect("/?signedin=1");
            });
        })(req, res, next);
    })

    router.get('/signup', function(req, res) {
        if (req.user) return res.redirect("/");
        return responseFactory.sendRenderedResponse("public/signup", req, res, { captcha: app.recaptcha.render() });
    })

    router.get('/account', function(req, res) {
        if (!req.user) return res.redirect("/signin");
        return responseFactory.sendRenderedResponse("public/account", req, res);
    })

    router.post('/signup', signupRatelimit.prevent, function(req, res, next) {
        function renderResponse(errorMsg) {
            return responseFactory.sendRenderedResponse("public/signup", req, res, { captcha: app.recaptcha.render(), error: { message: errorMsg || "An unknown error occurred" }, username: req.body.username });
        }
        if (req.user) return res.redirect("/");
        if (!req.body.username || !req.body.password || !req.body.passwordverify) return renderResponse("Please fill out all the fields.")
        if (req.body.password != req.body.passwordverify) return renderResponse("The passwords you entered did not match.")
        app.recaptcha.verify(req, error => {
            if(error) return renderResponse("Please fill in the captcha properly.")
            User.register(req.body.username, req.body.password, function(user, error) {
                if(!user) return renderResponse(error.message);
                req.login(user, function(err) {
                    if (err) return renderResponse(null);
                    return res.redirect("/?signedup=1");
                });
            });
        });
    })

    router.get('/auth/google', function(req, res, next) {
        passport.authenticate('google', { scope: ['https://www.googleapis.com/auth/plus.login'] }, function(err, user, info) {
            if (!user) return responseFactory.sendRenderedResponse("public/signin", req, res, { error: info.error || { message: "An unknown error occurred." }, username: req.body.username });
            req.login(user, function(err) {
                if (err) return responseFactory.sendRenderedResponse("public/signin", req, res, { error: { message: "An unknown error occurred." }, username: req.body.username });
                return res.redirect("/?signedin=1");
            });
        })(req, res, next);
    })

    router.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/signup' }), function(req, res) {
        res.redirect('/?signedin=1');
    })

    router.get('/auth/discord', passport.authenticate('discord'));
    router.get('/auth/discord/callback', passport.authenticate('discord', {
        failureRedirect: '/signup',
        successRedirect: '/?signedin=1'
    }), function(req, res) {
        res.redirect('/?signedin=1') // Successful auth 
    });

    router.get('/auth/facebook', passport.authenticate('facebook'));
    router.get('/auth/facebook/callback', passport.authenticate('facebook', {
        failureRedirect: '/signup',
        successRedirect: '/?signedin=1'
    }), function(req, res) {
        res.redirect('/?signedin=1') // Successful auth 
    });

    router.get('/auth/github', passport.authenticate('github'));
    router.get('/auth/github/callback', passport.authenticate('github', {
        failureRedirect: '/signup',
        successRedirect: '/?signedin=1'
    }), function(req, res) {
        res.redirect('/?signedin=1') // Successful auth 
    });

    router.get('/auth/reddit', function(req, res, next){
        req.session.state = Math.floor(Math.random() * 10000).toString(2);
        passport.authenticate('reddit', {
            state: req.session.state
        })(req, res, next);
    })

    router.get('/auth/reddit/callback', function(req, res, next){
        // Check for origin via state token
        if (req.query.state == req.session.state){
            passport.authenticate('reddit', {
                successRedirect: '/?signedin=1',
                failureRedirect: '/signup'
            })(req, res, next);
        } else {
            next( new Error(403) );
        }
    });

    router.get('/auth/twitter', passport.authenticate('twitter'));

    router.get('/auth/twitter/callback', passport.authenticate('twitter', { failureRedirect: '/signup' }), function(req, res) {
        res.redirect('/?signedin=1');
    });

    router.get('/signout', function(req, res) {
        req.logout();
        res.redirect("/?signedout=1");
    })

    return router;
}

PublicRouter.prototype = Object.create(PublicRouter.prototype);

module.exports = PublicRouter;

'use strict';

module.exports = class RequestSpecValidationError {
    constructor (errors) {
        this.status = 400;
        this.errors = errors;
    }

    writeResponse (req, res) {
        res.status(this.status).json({
            errors: this.errors
        }).end();
    }
};

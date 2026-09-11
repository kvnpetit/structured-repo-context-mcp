package handler

import "net/http"

// HandleRequest is the local HTTP request handler entrypoint.
func HandleRequest(writer http.ResponseWriter, request *http.Request) {

	writer.WriteHeader(http.StatusNoContent)
}

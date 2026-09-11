use axum::{Json, Router, extract::State};
use duo_types::{IndexFileRequest, IndexFileResponse, SearchSymbolsRequest, Symbol};
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/search/code", axum::routing::post(index_file))
        .route("/search/symbols", axum::routing::post(search_symbols))
}

async fn index_file(
    State(state): State<crate::server::AppState>,
    Json(req): Json<IndexFileRequest>,
) -> Result<Json<IndexFileResponse>> {
    let code_search = state.code_search.get()?;
    let path = req.path.clone();
    tokio::task::spawn_blocking(move || {
        code_search.index_file(&req.path, &req.content, &req.language)
    })
    .await??;
    Ok(Json(IndexFileResponse {
        indexed: true,
        path,
    }))
}

async fn search_symbols(
    State(state): State<crate::server::AppState>,
    Json(req): Json<SearchSymbolsRequest>,
) -> Result<Json<Vec<Symbol>>> {
    let code_search = state.code_search.get()?;
    let result =
        tokio::task::spawn_blocking(move || code_search.search_symbols(&req.query, req.limit))
            .await??;
    Ok(Json(result))
}

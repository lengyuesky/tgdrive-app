//! 影视刮削应用：宿主仅提供通用文件能力，业务与持久状态都属于此应用。
pub mod actors;
mod application;
pub mod database;
pub mod engine;
pub mod images;
pub mod metatube;
pub mod model;
pub mod nfo;
mod page_api;
pub mod planner;
pub mod scan;
pub mod variant;
pub mod writes;

pub use application::Application;

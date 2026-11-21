//! 图片在应用后端有界解码与裁剪；超限降低编码质量/尺寸，不截断 JPEG 字节。
use image::{DynamicImage, ImageEncoder, ImageReader};
use std::io::Cursor;
use tgdrive_backend_sdk::{Error, Result};
use tgdrive_contract::error_code;

pub const POSTER_LIMIT: usize = 2 * 1024 * 1024;
pub const ACTOR_LIMIT: usize = 128 * 1024;
pub const PIXEL_LIMIT: u64 = 16_000_000;
fn invalid() -> Error {
    Error::api(
        error_code::INVALID_REQUEST,
        "图片无法解码或超过 1600 万像素预算",
    )
}
fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid())
}
pub fn decode(bytes: &[u8]) -> Result<DynamicImage> {
    let (width, height) = reader(bytes)?.into_dimensions().map_err(|_| invalid())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > PIXEL_LIMIT {
        return Err(invalid());
    }
    let mut reader = reader(bytes)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| invalid())
}
pub fn encode(bytes: &[u8], portrait: bool) -> Result<Vec<u8>> {
    let decoded = decode(bytes)?;
    let max_unit = if portrait { 120 } else { 600 };
    let limit = if portrait { ACTOR_LIMIT } else { POSTER_LIMIT };
    let mut unit = (decoded.width() / 2)
        .min(decoded.height() / 3)
        .clamp(1, max_unit);
    loop {
        let rgb = decoded
            .resize_to_fill(unit * 2, unit * 3, image::imageops::FilterType::Lanczos3)
            .to_rgb8();
        for quality in [90, 80, 65, 50] {
            let mut output = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
                .write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|_| invalid())?;
            if output.len() <= limit {
                return Ok(output);
            }
        }
        if unit == 1 {
            return Err(Error::api(
                error_code::PAYLOAD_TOO_LARGE,
                "JPEG 无法满足输出预算，未截断也未写入",
            ));
        }
        unit = (unit / 2).max(1);
    }
}
pub async fn prepare(bytes: Vec<u8>, portrait: bool) -> Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || encode(&bytes, portrait))
        .await
        .map_err(|_| Error::api(error_code::INTERNAL_ERROR, "图片处理未能完成"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut output = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut output)
            .encode_image(&image::RgbImage::from_pixel(
                width,
                height,
                image::Rgb([20, 130, 210]),
            ))
            .unwrap();
        output
    }
    #[test]
    fn poster_and_portrait_are_exact_two_by_three_bounded_jpeg() {
        for portrait in [false, true] {
            for (width, height) in [(358, 538), (300, 100), (1, 1)] {
                let bytes = encode(&jpeg(width, height), portrait).unwrap();
                assert!(bytes.starts_with(&[0xff, 0xd8]));
                assert!(bytes.len() <= if portrait { ACTOR_LIMIT } else { POSTER_LIMIT });
                let decoded = image::load_from_memory(&bytes).unwrap();
                assert_eq!(decoded.width() * 3, decoded.height() * 2);
            }
        }
        assert!(encode(b"<html>error</html>", false).is_err());
        assert!(decode(b"<svg/>").is_err());
    }
    #[test]
    fn noisy_portraits_keep_a_complete_decodable_jpeg() {
        let mut random = 7u32;
        let image = image::RgbImage::from_fn(600, 900, |_, _| {
            let mut rgb = [0; 3];
            for channel in &mut rgb {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                *channel = random as u8;
            }
            image::Rgb(rgb)
        });
        let mut input = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut input, 95)
            .encode_image(&image)
            .unwrap();
        let output = encode(&input, true).unwrap();
        assert!(output.len() <= ACTOR_LIMIT);
        assert!(image::load_from_memory(&output).is_ok());
        assert!(output.ends_with(&[0xff, 0xd9]));
    }
    #[test]
    fn advertised_huge_jpeg_dimensions_fail_before_decode() {
        let mut bytes = jpeg(2, 3);
        let marker = bytes.windows(2).position(|s| s == [0xff, 0xc0]).unwrap();
        bytes[marker + 5..marker + 9].fill(0xff);
        assert!(decode(&bytes).is_err());
    }
}

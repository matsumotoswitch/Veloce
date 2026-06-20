

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;
    use fast_image_resize as fr;
    use image::RgbaImage;

    #[test]
    fn test_fast_image_resize_logic() {
        // 1920x1080 のダミー画像を生成
        let width = 1920;
        let height = 1080;
        let dummy_pixels = vec![255u8; (width * height * 4) as usize];
        let rgba_img = RgbaImage::from_raw(width, height, dummy_pixels).unwrap();

        // リサイズ計算ロジック
        let mut dst_width = width;
        let mut dst_height = height;
        if width > 512 || height > 512 {
            let ratio = f32::min(512.0 / width as f32, 512.0 / height as f32);
            dst_width = (width as f32 * ratio).round() as u32;
            dst_height = (height as f32 * ratio).round() as u32;
        }

        // 1920x1080 はアスペクト比 16:9。横幅が512の場合、高さは 512 * (1080/1920) = 288 になるはず
        assert_eq!(dst_width, 512);
        assert_eq!(dst_height, 288);

        // 高速リサイズ処理の実行
        let src_width = NonZeroU32::new(width).unwrap();
        let src_height = NonZeroU32::new(height).unwrap();
        let src_image = fr::images::Image::from_vec_u8(
            src_width,
            src_height,
            rgba_img.into_raw(),
            fr::PixelType::U8x4,
        ).unwrap();

        let dst_w_nz = NonZeroU32::new(dst_width).unwrap();
        let dst_h_nz = NonZeroU32::new(dst_height).unwrap();
        let mut dst_image = fr::images::Image::new(
            dst_w_nz,
            dst_h_nz,
            fr::PixelType::U8x4,
        );

        let mut resizer = fr::Resizer::new();
        resizer.resize(&src_image, &mut dst_image, None).unwrap();

        let result_img = RgbaImage::from_raw(dst_width, dst_height, dst_image.into_vec()).unwrap();
        assert_eq!(result_img.width(), 512);
        assert_eq!(result_img.height(), 288);
    }
}

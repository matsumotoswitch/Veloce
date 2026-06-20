#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;
    use fast_image_resize as fr;

    #[test]
    fn test_resize_api() {
        let width = NonZeroU32::new(1920).unwrap();
        let height = NonZeroU32::new(1080).unwrap();
        let src_image = fr::Image::new(width, height, fr::PixelType::U8x4);

        let dst_width = NonZeroU32::new(512).unwrap();
        let dst_height = NonZeroU32::new(288).unwrap();
        let mut dst_image = fr::Image::new(dst_width, dst_height, fr::PixelType::U8x4);

        let mut resizer = fr::Resizer::new();
        resizer.resize(&src_image, &mut dst_image, None).unwrap();
    }
}
